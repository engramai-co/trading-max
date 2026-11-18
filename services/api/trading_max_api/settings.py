"""Durable non-secret profile and integration metadata repositories."""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from pydantic_ai import CancellationToken
from trading_max.infrastructure import SqliteDatabase

from .assistant_settings import (
    ASSISTANT_CONSENT_REVISION,
    AssistantSettingsError,
    parse_assistant_route,
    validate_assistant_integration,
)
from .llm_routing import (
    PROVIDER_REGISTRY,
    SYNTHESIS_WORKLOADS,
    LLMRoute,
    LLMRouteError,
    parse_route,
)
from .models import (
    AssistantPreferences,
    AssistantPreferencesUpdate,
    AutomationSettingsUpdate,
    IntegrationSummary,
    LLMRoutePolicy,
    LLMRoutePolicyUpdate,
    UserProfile,
    UserProfilePatch,
)

MIGRATIONS = Path(__file__).resolve().parents[3] / "backend" / "migrations"
DEFAULT_ACCOUNT_LABELS = {"A": "Invest", "B": "Stocks ISA", "C": "CFD"}


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).isoformat().replace("+00:00", "Z")


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _integration_id(provider: str, profile: str | None = None) -> str:
    return f"{provider}:{profile or 'default'}"


@dataclass(frozen=True, slots=True)
class AutomationPreferences:
    live_enabled: bool
    performance_enabled: bool
    research_enabled: bool
    revision: int
    updated_at: datetime
    evidence_notices_enabled: bool = False

    @property
    def nightly_enabled(self) -> bool:
        return self.research_enabled

    @property
    def intraday_enabled(self) -> bool:
        return self.live_enabled


class SettingsRepository:
    """SQLite-backed settings metadata with revision and audit semantics."""

    def __init__(self, data_root: Path) -> None:
        self.database = SqliteDatabase(data_root / "trading_max.db", migrations_dir=MIGRATIONS)
        self._assistant_access = CancellationToken()
        self._background_access = CancellationToken()
        # Dispatch reads one row without waiting for a writer or sharing its transaction.
        self._dispatch_reader = sqlite3.connect(
            self.database.path.as_uri() + "?mode=ro",
            uri=True,
            timeout=0,
            check_same_thread=False,
            isolation_level=None,
        )
        self._dispatch_lock = threading.Lock()

    def close(self) -> None:
        with self._dispatch_lock:
            self._dispatch_reader.close()
        self.database.close()

    @staticmethod
    def _profile(row: Any) -> UserProfile:
        return UserProfile(
            assistant_enabled=bool(row["assistant_enabled"]),
            profile_id=row["profile_id"],
            display_name=row["display_name"],
            initials=row["initials"],
            avatar_color=row["avatar_color"],
            locale=row["locale"],
            base_currency=row["base_currency"],
            timezone=row["timezone"],
            account_labels=json.loads(row["account_labels_json"]),
            revision=row["revision"],
            updated_at=_parse_datetime(row["updated_at"]) or _now(),
        )

    def get_profile(self) -> UserProfile:
        with self.database.read() as connection:
            row = connection.execute(
                """SELECT p.*, a.enabled AND a.accepted_consent_revision = ? AS assistant_enabled
                   FROM user_profile p LEFT JOIN assistant_preferences a
                   ON a.preference_id = p.profile_id WHERE p.profile_id = 'local'""",
                (ASSISTANT_CONSENT_REVISION,),
            ).fetchone()
        if row is None:
            raise RuntimeError("local profile was not initialized")
        return self._profile(row)

    @staticmethod
    def _automation_preferences(row: Any) -> AutomationPreferences:
        return AutomationPreferences(
            live_enabled=bool(row["live_enabled"]),
            performance_enabled=bool(row["performance_enabled"]),
            research_enabled=bool(row["research_enabled"]),
            revision=int(row["revision"]),
            updated_at=_parse_datetime(row["updated_at"]) or _now(),
            evidence_notices_enabled=bool(row["evidence_notices_enabled"]),
        )

    def ensure_automation_preferences(
        self,
        *,
        nightly_enabled: bool,
        intraday_enabled: bool,
        performance_enabled: bool | None = None,
        research_enabled: bool | None = None,
    ) -> AutomationPreferences:
        """Seed runtime toggles from deployment defaults exactly once."""

        with self.database.transaction(immediate=True) as connection:
            connection.execute(
                """INSERT OR IGNORE INTO automation_preferences (
                       preference_id, nightly_enabled, intraday_enabled,
                       live_enabled, performance_enabled, research_enabled,
                       revision, updated_at
                   ) VALUES ('local', ?, ?, ?, ?, ?, 1, ?)""",
                (
                    int(nightly_enabled),
                    int(intraday_enabled),
                    int(intraday_enabled),
                    int(
                        performance_enabled if performance_enabled is not None else nightly_enabled
                    ),
                    int(research_enabled if research_enabled is not None else nightly_enabled),
                    _iso(),
                ),
            )
        return self.get_automation_preferences()

    def get_automation_preferences(self) -> AutomationPreferences:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM automation_preferences WHERE preference_id = 'local'"
            ).fetchone()
        if row is None:
            raise RuntimeError("automation preferences were not initialized")
        return self._automation_preferences(row)

    def update_automation_preferences(
        self,
        request: AutomationSettingsUpdate,
        *,
        actor: str = "local",
    ) -> AutomationPreferences:
        current = self.get_automation_preferences()
        if not any(
            value is not None
            for value in (
                request.live_enabled,
                request.performance_enabled,
                request.research_enabled,
                request.nightly_enabled,
                request.intraday_enabled,
                request.evidence_notices_enabled,
            )
        ):
            raise ValueError("at least one automation setting must be supplied")
        if (
            request.live_enabled is not None
            and request.intraday_enabled is not None
            and request.live_enabled != request.intraday_enabled
        ):
            raise ValueError("liveEnabled conflicts with legacy intradayEnabled")
        if (
            request.research_enabled is not None
            and request.nightly_enabled is not None
            and request.research_enabled != request.nightly_enabled
        ):
            raise ValueError("researchEnabled conflicts with legacy nightlyEnabled")
        if request.expected_revision is not None and request.expected_revision != current.revision:
            raise ValueError(
                "automation settings revision conflict: "
                f"expected {request.expected_revision}, current {current.revision}"
            )
        revision = current.revision + 1
        updated_at = _iso()
        live_enabled = (
            request.live_enabled
            if request.live_enabled is not None
            else request.intraday_enabled
            if request.intraday_enabled is not None
            else current.live_enabled
        )
        performance_enabled = (
            request.performance_enabled
            if request.performance_enabled is not None
            else current.performance_enabled
        )
        research_enabled = (
            request.research_enabled
            if request.research_enabled is not None
            else request.nightly_enabled
            if request.nightly_enabled is not None
            else current.research_enabled
        )
        evidence_notices_enabled = (
            request.evidence_notices_enabled
            if request.evidence_notices_enabled is not None
            else current.evidence_notices_enabled
        )
        with self.database.transaction(immediate=True) as connection:
            updated = connection.execute(
                """UPDATE automation_preferences
                   SET nightly_enabled = ?, intraday_enabled = ?,
                       live_enabled = ?, performance_enabled = ?, research_enabled = ?,
                       evidence_notices_enabled = ?, revision = ?, updated_at = ?
                   WHERE preference_id = 'local' AND revision = ?""",
                (
                    int(research_enabled),
                    int(live_enabled),
                    int(live_enabled),
                    int(performance_enabled),
                    int(research_enabled),
                    int(evidence_notices_enabled),
                    revision,
                    updated_at,
                    current.revision,
                ),
            )
            if updated.rowcount != 1:
                raise ValueError(
                    "automation settings revision conflict; reload the current settings"
                )
            self._audit(
                connection,
                actor=actor,
                action="automation.updated",
                integration_id=None,
                revision=revision,
                metadata={
                    "live_enabled": live_enabled,
                    "performance_enabled": performance_enabled,
                    "research_enabled": research_enabled,
                    "evidence_notices_enabled": evidence_notices_enabled,
                },
            )
        return self.get_automation_preferences()

    def update_profile(self, patch: UserProfilePatch, *, actor: str = "local") -> UserProfile:
        current = self.get_profile()
        values = current.model_dump(mode="python", by_alias=False)
        values.update(
            patch.model_dump(
                by_alias=False,
                exclude_unset=True,
                exclude_none=True,
            )
        )
        if str(values["base_currency"]).upper() != "GBP":
            raise ValueError("only GBP is supported as the base currency")
        values["base_currency"] = str(values["base_currency"]).upper()
        try:
            ZoneInfo(values["timezone"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc
        updated_at = _iso()
        revision = current.revision + 1
        labels = values["account_labels"] or DEFAULT_ACCOUNT_LABELS
        if set(labels) - set(DEFAULT_ACCOUNT_LABELS):
            raise ValueError("account_labels may only contain A, B, and C")
        if any(
            not isinstance(label, str) or not 1 <= len(label.strip()) <= 80
            for label in labels.values()
        ):
            raise ValueError("account labels must contain 1-80 characters")
        with self.database.transaction(immediate=True) as connection:
            connection.execute(
                """UPDATE user_profile SET display_name = ?, initials = ?, avatar_color = ?,
                   locale = ?, base_currency = ?, timezone = ?, account_labels_json = ?,
                   revision = ?, updated_at = ? WHERE profile_id = 'local'""",
                (
                    values["display_name"].strip(),
                    values["initials"].strip().upper(),
                    values["avatar_color"],
                    values["locale"],
                    values["base_currency"].upper(),
                    values["timezone"],
                    json.dumps(labels, ensure_ascii=False, sort_keys=True),
                    revision,
                    updated_at,
                ),
            )
            self._audit(
                connection,
                actor=actor,
                action="profile.updated",
                integration_id=None,
                revision=revision,
                metadata={"fields": sorted(patch.model_dump(by_alias=False, exclude_unset=True))},
            )
        return self.get_profile()

    @staticmethod
    def _summary(row: Any) -> IntegrationSummary:
        spec = PROVIDER_REGISTRY.get(row["provider"])
        has_credential = bool(row["credential_ref"] and row["credential_fingerprint"])
        optional_key = spec is not None and spec.auth_method == "optional_api_key"
        keyless_configured = bool(
            optional_key
            and row["model"]
            and row["base_url"]
            and row["last_test_status"] == "succeeded"
        )
        return IntegrationSummary(
            integration_id=row["integration_id"],
            provider=row["provider"],
            profile=row["profile"],
            enabled=bool(row["enabled"]),
            configured=has_credential or keyless_configured,
            model=row["model"],
            base_url=row["base_url"],
            credential_fingerprint=row["credential_fingerprint"],
            needs_secret=not optional_key and not has_credential,
            last_test_at=_parse_datetime(row["last_test_at"]),
            last_test_status=row["last_test_status"] or "untested",
            last_error_code=row["last_error_code"],
            revision=row["revision"],
            updated_at=_parse_datetime(row["updated_at"]) or _now(),
        )

    def list_integrations(self) -> list[IntegrationSummary]:
        with self.database.read() as connection:
            rows = connection.execute(
                "SELECT * FROM integration_settings ORDER BY provider, profile"
            ).fetchall()
        return [self._summary(row) for row in rows]

    def get_integration(
        self, provider: str, profile: str | None = None
    ) -> IntegrationSummary | None:
        integration_id = _integration_id(provider, profile)
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM integration_settings WHERE integration_id = ?",
                (integration_id,),
            ).fetchone()
        return self._summary(row) if row is not None else None

    @staticmethod
    def _assistant_preferences(row: Any) -> AssistantPreferences:
        return AssistantPreferences(
            enabled=bool(row["enabled"]),
            route=row["route"],
            reasoning=row["reasoning"],
            background_briefs_enabled=bool(row["background_briefs_enabled"]),
            share_valuation_assumptions=bool(row["share_valuation_assumptions"]),
            accepted_consent_revision=row["accepted_consent_revision"],
            accepted_at=_parse_datetime(row["accepted_at"]),
            accepted_destination=row["accepted_destination"],
            revision=int(row["revision"]),
            updated_at=_parse_datetime(row["updated_at"]) or _now(),
        )

    def get_assistant_preferences(self) -> AssistantPreferences:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM assistant_preferences WHERE preference_id = 'local'"
            ).fetchone()
        return self._assistant_preferences(row)

    def assistant_connection_snapshot(
        self,
        *,
        background: bool = False,
    ) -> tuple[AssistantPreferences, IntegrationSummary | None, CancellationToken]:
        with self.database.transaction():
            current = self.get_assistant_preferences()
            provider = (current.route or "").partition("/")[0]
            integration = self.get_integration(provider) if provider else None
            return (
                current,
                integration,
                self._background_access if background else self._assistant_access,
            )

    def assistant_dispatch_state(
        self, integration_id: str
    ) -> tuple[int, int | None, int, int | None, int]:
        with self._dispatch_lock:
            return self._dispatch_reader.execute(
                """SELECT p.enabled, p.accepted_consent_revision, p.revision, i.revision, p.background_briefs_enabled
                   FROM assistant_preferences p LEFT JOIN integration_settings i ON i.integration_id = ?
                   WHERE p.preference_id = 'local'""",
                (integration_id,),
            ).fetchone()

    def _cancel_background_access(self) -> None:
        previous, self._background_access = self._background_access, CancellationToken()
        previous.cancel()

    def _cancel_assistant_access(self) -> None:
        # Called under the same writer lock as the preferences and integration changes.
        self._cancel_background_access()
        previous, self._assistant_access = self._assistant_access, CancellationToken()
        previous.cancel()

    def _assistant_integration_changed(self, connection: sqlite3.Connection, provider: str) -> None:
        if (
            provider in PROVIDER_REGISTRY
            and connection.execute(
                "UPDATE assistant_preferences SET revision = revision + 1, updated_at = ? WHERE route LIKE ?",
                (_iso(), provider + "/%"),
            ).rowcount
        ):
            self._cancel_assistant_access()

    def save_assistant_preferences(
        self,
        update: AssistantPreferencesUpdate,
        *,
        actor: str = "local",
    ) -> AssistantPreferences:
        with self.database.transaction(immediate=True) as connection:
            previous = self.get_assistant_preferences()
            if (
                update.expected_revision is not None
                and update.expected_revision != previous.revision
            ):
                raise AssistantSettingsError(
                    "assistant_preferences_conflict", "reload the current assistant preferences"
                )
            changes = update.model_dump(by_alias=False, exclude_unset=True)
            enabled = previous.enabled if update.enabled is None else update.enabled
            route_id = changes.get("route", previous.route)
            reasoning = changes.get("reasoning", previous.reasoning)
            background = (
                previous.background_briefs_enabled
                if update.background_briefs_enabled is None
                else update.background_briefs_enabled
            )
            assumptions = (
                previous.share_valuation_assumptions
                if update.share_valuation_assumptions is None
                else update.share_valuation_assumptions
            )
            provider_changed = (route_id or "").partition("/")[0] != (
                previous.route or ""
            ).partition("/")[0]
            consent = changes.get("accepted_consent_revision", previous.accepted_consent_revision)
            consent_updated = "accepted_consent_revision" in changes
            if consent_updated and consent not in (None, ASSISTANT_CONSENT_REVISION):
                raise AssistantSettingsError(
                    "assistant_consent_required", "accept the current assistant consent revision"
                )
            if consent_updated and consent is None and update.enabled is None:
                enabled = False
            if provider_changed and not consent_updated:
                consent = None
            if enabled and consent != ASSISTANT_CONSENT_REVISION:
                raise AssistantSettingsError(
                    "assistant_consent_required", "accept the current assistant consent revision"
                )
            granting_consent = consent_updated and consent is not None
            accepted_destination = previous.accepted_destination if consent is not None else None
            if enabled or granting_consent or ("route" in changes and route_id is not None):
                route = parse_assistant_route(route_id)
                route_id = route.route_id
                spec = PROVIDER_REGISTRY[route.provider]
                destination = spec.base_url
                if enabled or (granting_consent and spec.local):
                    _, destination = validate_assistant_integration(
                        route, self.get_integration(route.provider)
                    )
                if granting_consent:
                    if (spec.local or update.expected_consent_destination is not None) and (
                        update.expected_consent_destination != destination
                    ):
                        raise AssistantSettingsError(
                            "assistant_preferences_conflict",
                            "review the current assistant destination",
                        )
                    accepted_destination = destination
                if enabled and accepted_destination != destination:
                    raise AssistantSettingsError(
                        "assistant_consent_required", "accept the current assistant destination"
                    )
            access_changed = (
                enabled,
                route_id,
                reasoning,
                assumptions,
                consent,
                accepted_destination,
            ) != (
                previous.enabled,
                previous.route,
                previous.reasoning,
                previous.share_valuation_assumptions,
                previous.accepted_consent_revision,
                previous.accepted_destination,
            )
            if not access_changed and background == previous.background_briefs_enabled:
                return previous
            now = _now()
            accepted_at = (
                None
                if consent is None
                else previous.accepted_at
                if consent == previous.accepted_consent_revision
                and accepted_destination == previous.accepted_destination
                and not provider_changed
                else now
            )
            revision = previous.revision + 1
            row = connection.execute(
                """UPDATE assistant_preferences SET enabled = ?, route = ?, reasoning = ?,
                   background_briefs_enabled = ?, share_valuation_assumptions = ?,
                   accepted_consent_revision = ?, accepted_destination = ?, accepted_at = ?, revision = ?, updated_at = ?
                   WHERE preference_id = 'local' RETURNING *""",
                (
                    int(enabled),
                    route_id,
                    reasoning,
                    int(background),
                    int(assumptions),
                    consent,
                    accepted_destination,
                    _iso(accepted_at) if accepted_at is not None else None,
                    revision,
                    _iso(now),
                ),
            ).fetchone()
            self._audit(
                connection,
                actor=actor,
                action="assistant_preferences.updated",
                integration_id=None,
                revision=revision,
                metadata={"enabled": enabled, "accepted_consent_revision": consent},
            )
            if access_changed:
                self._cancel_assistant_access()
            else:
                self._cancel_background_access()
            return self._assistant_preferences(row)

    def get_route_policy(self) -> LLMRoutePolicy:
        with self.database.read() as connection:
            row = connection.execute(
                "SELECT * FROM llm_route_policy WHERE policy_id = 'active'"
            ).fetchone()
        if row is None:  # pragma: no cover - protected by migration 0009
            raise RuntimeError("active LLM route policy was not initialized")
        try:
            overrides = json.loads(row["overrides_json"])
        except json.JSONDecodeError as exc:  # pragma: no cover - corruption guard
            raise RuntimeError("active LLM route policy is corrupted") from exc
        if not isinstance(overrides, dict) or any(
            not isinstance(key, str) or not isinstance(value, str)
            for key, value in overrides.items()
        ):
            raise RuntimeError("active LLM route policy has invalid overrides")
        return LLMRoutePolicy(
            default_route=row["default_route"],
            overrides=overrides,
            revision=row["revision"],
            updated_at=_parse_datetime(row["updated_at"]) or _now(),
        )

    def get_runtime_route(self, workload: str | None = None) -> LLMRoute:
        policy = self.get_route_policy()
        value = policy.overrides.get(workload or "", policy.default_route)
        try:
            if workload is not None and workload not in SYNTHESIS_WORKLOADS:
                raise LLMRouteError("not a synthesis workload")
            return parse_route(value, workload=workload or "portfolio")
        except LLMRouteError as exc:
            raise RuntimeError(f"invalid persisted LLM route policy: {exc}") from exc

    def save_route_policy(
        self,
        request: LLMRoutePolicyUpdate,
        *,
        actor: str = "local",
    ) -> LLMRoutePolicy:
        try:
            default_route = parse_route(request.default_route, workload="portfolio").route_id
            invalid_workloads = set(request.overrides) - set(SYNTHESIS_WORKLOADS)
            if invalid_workloads:
                raise LLMRouteError(
                    f"unknown LLM workloads: {', '.join(sorted(invalid_workloads))}"
                )
            overrides = {}
            for workload, route in request.overrides.items():
                if route.strip():
                    overrides[workload] = parse_route(route, workload=workload).route_id
        except LLMRouteError as exc:
            raise ValueError(str(exc)) from exc

        current = self.get_route_policy()
        if request.expected_revision is not None and request.expected_revision != current.revision:
            raise ValueError(
                f"LLM route policy revision conflict: expected {request.expected_revision}, "
                f"current {current.revision}"
            )
        revision = current.revision + 1
        now = _iso()
        with self.database.transaction(immediate=True) as connection:
            updated = connection.execute(
                """UPDATE llm_route_policy
                   SET default_route = ?, overrides_json = ?, revision = ?, updated_at = ?
                   WHERE policy_id = 'active' AND revision = ?""",
                (
                    default_route,
                    json.dumps(overrides, ensure_ascii=False, sort_keys=True),
                    revision,
                    now,
                    current.revision,
                ),
            )
            if updated.rowcount != 1:
                raise ValueError("LLM route policy revision conflict; reload the current policy")
            self._audit(
                connection,
                actor=actor,
                action="llm_route_policy.updated",
                integration_id=None,
                revision=revision,
                metadata={
                    "default_route": default_route,
                    "override_workloads": sorted(overrides),
                },
            )
        return self.get_route_policy()

    def get_runtime_llm(self) -> dict[str, str | None]:
        """Return legacy runtime metadata for callers not yet route-aware."""

        route = self.get_runtime_route()
        row = self.get_integration(route.provider)
        if row is not None and row.enabled and row.configured:
            return {
                "provider": route.provider,
                "model": row.model or route.model,
                "base_url": row.base_url,
            }
        return {"provider": "fake", "model": "trading-max-fake-v1", "base_url": None}

    def credential_reference(self, provider: str, profile: str | None = None) -> str:
        return _integration_id(provider, profile)

    def save_integration(
        self,
        *,
        provider: str,
        profile: str | None,
        enabled: bool,
        model: str | None,
        base_url: str | None,
        credential_fingerprint: str | None,
        test_status: str,
        error_code: str | None = None,
        actor: str = "local",
        use_as_default: bool = False,
    ) -> IntegrationSummary:
        route = (
            parse_route(f"{provider}/{model}", workload="portfolio").route_id
            if use_as_default
            else None
        )
        if route and not enabled:
            raise ValueError("the default provider must be enabled")
        integration_id = _integration_id(provider, profile)
        now = _iso()
        tested_at = now if test_status != "untested" else None
        with self.database.transaction(immediate=True) as connection:
            previous = connection.execute(
                "SELECT revision FROM integration_settings WHERE integration_id = ?",
                (integration_id,),
            ).fetchone()
            revision = int(previous["revision"]) + 1 if previous else 1
            connection.execute(
                """INSERT INTO integration_settings (
                    integration_id, provider, profile, enabled, model, base_url,
                    credential_ref, credential_fingerprint, last_test_at,
                    last_test_status, last_error_code, revision, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(integration_id) DO UPDATE SET
                    enabled=excluded.enabled, model=excluded.model, base_url=excluded.base_url,
                    credential_ref=excluded.credential_ref,
                    credential_fingerprint=excluded.credential_fingerprint,
                    last_test_at=excluded.last_test_at, last_test_status=excluded.last_test_status,
                    last_error_code=excluded.last_error_code, revision=excluded.revision,
                    updated_at=excluded.updated_at""",
                (
                    integration_id,
                    provider,
                    profile,
                    int(enabled),
                    model,
                    base_url,
                    integration_id,
                    credential_fingerprint,
                    tested_at,
                    test_status,
                    error_code,
                    revision,
                    now,
                ),
            )
            spec = PROVIDER_REGISTRY.get(provider)
            if spec is not None and spec.local:
                # A replacement endpoint needs fresh consent even if the model ID stays the same.
                connection.execute(
                    """UPDATE assistant_preferences SET enabled = 0, accepted_consent_revision = NULL,
                       accepted_destination = NULL, accepted_at = NULL
                       WHERE route LIKE ? AND accepted_consent_revision IS NOT NULL
                       AND accepted_destination IS NOT ?""",
                    (provider + "/%", base_url or spec.base_url),
                )
            self._assistant_integration_changed(connection, provider)
            self._audit(
                connection,
                actor=actor,
                action=f"integration.{test_status}",
                integration_id=integration_id,
                revision=revision,
                metadata={"provider": provider, "profile": profile, "enabled": enabled},
            )
            if route:
                connection.execute(
                    """UPDATE llm_route_policy SET default_route = ?,
                       revision = revision + 1, updated_at = ? WHERE policy_id = 'active'""",
                    (route, now),
                )
                policy_revision = connection.execute(
                    "SELECT revision FROM llm_route_policy WHERE policy_id = 'active'"
                ).fetchone()["revision"]
                self._audit(
                    connection,
                    actor=actor,
                    action="llm_route_policy.updated",
                    integration_id=integration_id,
                    revision=policy_revision,
                    metadata={"default_route": route},
                )
        result = self.get_integration(provider, profile)
        if result is None:  # pragma: no cover - transaction invariant
            raise RuntimeError("integration metadata was not persisted")
        return result

    def set_integration_enabled(self, provider: str, enabled: bool) -> IntegrationSummary:
        integration_id = _integration_id(provider)
        with self.database.transaction(immediate=True) as connection:
            connection.execute(
                "UPDATE integration_settings SET enabled = ?, revision = revision + 1, updated_at = ? WHERE integration_id = ?",
                (int(enabled), _iso(), integration_id),
            )
            row = connection.execute(
                "SELECT revision FROM integration_settings WHERE integration_id = ?",
                (integration_id,),
            ).fetchone()
            if row is None:
                raise ValueError("integration is not configured")
            self._assistant_integration_changed(connection, provider)
            self._audit(
                connection,
                actor="local",
                action="integration.enabled",
                integration_id=integration_id,
                revision=row["revision"],
                metadata={"provider": provider, "enabled": enabled},
            )
        result = self.get_integration(provider)
        if result is None:  # pragma: no cover - transaction invariant
            raise RuntimeError("integration metadata was not persisted")
        return result

    def remove_integration(
        self,
        *,
        provider: str,
        profile: str | None,
        actor: str = "local",
    ) -> None:
        integration_id = _integration_id(provider, profile)
        with self.database.transaction(immediate=True) as connection:
            row = connection.execute(
                "SELECT revision FROM integration_settings WHERE integration_id = ?",
                (integration_id,),
            ).fetchone()
            revision = int(row["revision"]) + 1 if row else 1
            connection.execute(
                "DELETE FROM integration_settings WHERE integration_id = ?",
                (integration_id,),
            )
            self._assistant_integration_changed(connection, provider)
            self._audit(
                connection,
                actor=actor,
                action="integration.deleted",
                integration_id=integration_id,
                revision=revision,
                metadata={"provider": provider, "profile": profile},
            )

    @staticmethod
    def _audit(
        connection: Any,
        *,
        actor: str,
        action: str,
        integration_id: str | None,
        revision: int,
        metadata: dict[str, Any],
    ) -> None:
        connection.execute(
            """INSERT INTO settings_audit
               (created_at, actor, action, integration_id, revision, metadata_json)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (_iso(), actor, action, integration_id, revision, json.dumps(metadata, sort_keys=True)),
        )


__all__ = ["AutomationPreferences", "SettingsRepository"]
