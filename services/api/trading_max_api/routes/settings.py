"""Expose local integration settings with test-before-save enforcement."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from trading_max.ingestion.brokers.trading212 import (
    Trading212Client,
    Trading212Credentials,
    Trading212Error,
)
from trading_max.synthesis import ProviderError

from ..credentials import CredentialStoreError, secret_fingerprint
from ..llm_routing import (
    PROVIDER_REGISTRY,
    LLMRouteError,
    ProviderSpec,
    provider_routes,
    provider_spec,
)
from ..models import (
    ApiModel,
    AutomationSettings,
    AutomationSettingsUpdate,
    CfdAccountPreferenceUpdate,
    CfdImportStatus,
    DeepSeekIntegrationCandidate,
    DeepSeekIntegrationRequest,
    IntegrationOverview,
    IntegrationSummary,
    IntegrationTestResult,
    LLMIntegrationCandidate,
    LLMIntegrationRequest,
    LLMProviderDescriptor,
    LLMProvidersResponse,
    LLMRoutePolicy,
    LLMRoutePolicyUpdate,
    Trading212IntegrationCandidate,
    Trading212IntegrationRequest,
    UserProfile,
    UserProfilePatch,
)
from ..provider_runtime import ProviderRuntimeError
from ..valuation_assumptions import (
    ValuationAssumptionsHistoryEntry,
    ValuationAssumptionsState,
    ValuationAssumptionsUpsertRequest,
)
from .dependencies import app_service, require_write_auth

ALLOWED_DEEPSEEK_MODELS = frozenset(
    {
        "deepseek-chat",
        "deepseek-reasoner",
        "deepseek-v3",
        "deepseek-v4-flash",
    }
)

router = APIRouter(tags=["settings"])


def _automation_settings(request: Request) -> AutomationSettings:
    preferences = app_service(request, "settings_repository").get_automation_preferences()
    nightly = app_service(request, "scheduler")
    intraday = app_service(request, "intraday_scheduler")
    window_start, window_end = intraday.window_label
    return AutomationSettings(
        live_enabled=preferences.live_enabled,
        live_timezone=intraday.timezone_name,
        live_interval_seconds=intraday.interval_seconds,
        live_window_start=window_start,
        live_window_end=window_end,
        live_weekdays=list(intraday.weekdays),
        performance_enabled=preferences.performance_enabled,
        performance_timezone=app_service(request, "performance_scheduler").timezone_name,
        performance_interval_seconds=app_service(request, "performance_scheduler").interval_seconds,
        research_enabled=preferences.research_enabled,
        research_timezone=nightly.timezone_name,
        research_local_times=list(nightly.local_times),
        daily_reconciliation_local_time=(
            nightly.reconciliation_time.strftime("%H:%M")
            if nightly.reconciliation_time is not None
            else nightly.local_times[-1]
        ),
        nightly_enabled=preferences.nightly_enabled,
        nightly_timezone=nightly.timezone_name,
        nightly_local_time=nightly.local_time,
        nightly_local_times=list(nightly.local_times),
        intraday_enabled=preferences.intraday_enabled,
        intraday_timezone=intraday.timezone_name,
        intraday_interval_seconds=intraday.interval_seconds,
        intraday_window_start=window_start,
        intraday_window_end=window_end,
        intraday_weekdays=list(intraday.weekdays),
        revision=preferences.revision,
        updated_at=preferences.updated_at,
    )


def _check_deepseek_connection(*, api_key: str, model: str, base_url: str) -> str:
    with httpx.Client(timeout=15, follow_redirects=False) as client:
        response = client.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": "Reply with OK."}],
                "max_tokens": 32,
                "temperature": 0,
                "thinking": {"type": "disabled"},
            },
        )
        response.raise_for_status()
        payload = response.json()
        choices = payload.get("choices") or []
        content = (choices[0].get("message") or {}).get("content") if choices else None
        if not isinstance(content, str) or not content.strip():
            raise ValueError("provider returned an empty completion")
    return "DeepSeek connectivity check succeeded"


def _check_openai_compatible_connection(
    *,
    api_key: str,
    model: str,
    base_url: str,
    provider_label: str,
) -> str:
    with httpx.Client(timeout=20, follow_redirects=False) as client:
        response = client.post(
            f"{base_url.rstrip('/')}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": "Reply with OK."}],
                "max_tokens": 32,
                "temperature": 0,
                "thinking": {"type": "disabled"},
            },
        )
        response.raise_for_status()
        payload = response.json()
        choices = payload.get("choices") or []
        content = (choices[0].get("message") or {}).get("content") if choices else None
        if not isinstance(content, str) or not content.strip():
            raise ValueError("provider returned an empty completion")
    return f"{provider_label} connectivity check succeeded"


def _integration_overview(request: Request) -> IntegrationOverview:
    preferences = app_service(request, "settings_repository")
    settings = app_service(request, "settings")
    profile = preferences.get_profile()
    expected = (
        ("trading212", "invest"),
        ("trading212", "isa"),
        ("opencode", None),
        ("deepseek", None),
    )
    existing = {(item.provider, item.profile): item for item in preferences.list_integrations()}
    integrations: list[IntegrationSummary] = []
    for provider, integration_profile in expected:
        item = existing.get((provider, integration_profile))
        if item is None:
            item = IntegrationSummary(
                integration_id=preferences.credential_reference(
                    provider,
                    integration_profile,
                ),
                provider=provider,
                profile=integration_profile,
                updated_at=profile.updated_at,
            )
        integrations.append(item)
    return IntegrationOverview(
        deployment_mode=settings.deployment_mode,
        profile=profile,
        integrations=integrations,
        llm_providers=[LLMProviderDescriptor.model_validate(item) for item in provider_routes()],
        llm_route_policy=preferences.get_route_policy(),
    )


def _provider_url(value: str, *, provider: str) -> str:
    parsed = urlparse(value)
    allowed_hosts = {
        "deepseek": {"api.deepseek.com"},
        "openai": {"api.openai.com"},
        "opencode": {"opencode.ai"},
    }[provider]
    if parsed.scheme != "https" or parsed.hostname not in allowed_hosts:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "provider_url_not_allowed",
                "message": "provider base URL must use the approved HTTPS host",
            },
        )
    return value.rstrip("/")


def _safe_integration_error(exc: Exception) -> HTTPException:
    if isinstance(exc, CredentialStoreError):
        return HTTPException(
            status_code=503,
            detail={
                "code": "credential_store_unavailable",
                "message": "the operating-system credential store is unavailable",
            },
        )
    if isinstance(exc, (ProviderRuntimeError, ProviderError)):
        code = exc.code
    elif isinstance(exc, httpx.TimeoutException):
        code = "provider_unavailable"
    elif isinstance(exc, httpx.HTTPStatusError):
        response_status = exc.response.status_code
        if response_status in {401, 403}:
            code = "provider_auth_failed"
        elif response_status == 429:
            code = "provider_rate_limited"
        elif response_status >= 500:
            code = "provider_unavailable"
        else:
            code = "provider_model_rejected"
    elif isinstance(exc, (httpx.HTTPError, Trading212Error)):
        code = "provider_unavailable"
    elif isinstance(exc, ValueError):
        code = "provider_invalid_output"
    else:
        code = "integration_test_failed"
    status_code = 503 if code in {"provider_unavailable", "provider_rate_limited"} else 422
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": "integration test failed; no secret was returned",
        },
    )


def _test_trading212(
    profile: str,
    *,
    api_key_id: str,
    secret_key: str,
    environment: str,
) -> str:
    credentials = Trading212Credentials(
        profile=profile,
        api_key=api_key_id,
        api_secret=secret_key,
    )
    with Trading212Client(
        credentials,
        environment=environment,
        timeout_seconds=15,
    ) as client:
        client.snapshot()
    return "Trading 212 read-only account check succeeded"


def _candidate_digest(payload: ApiModel) -> str:
    canonical = json.dumps(
        payload.model_dump(mode="json", by_alias=True),
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(canonical).hexdigest()


def _validation_token(
    request: Request,
    *,
    integration_id: str,
    digest: str,
) -> str:
    payload = json.dumps(
        {
            "integrationId": integration_id,
            "digest": digest,
            "expiresAt": int(time.time()) + 600,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    encoded = base64.urlsafe_b64encode(payload).rstrip(b"=")
    signature = hmac.new(
        request.app.state.validation_secret,
        encoded,
        hashlib.sha256,
    ).digest()
    return f"{encoded.decode()}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def _require_validation_token(
    request: Request,
    *,
    integration_id: str,
    digest: str,
    token: str,
) -> None:
    try:
        encoded_text, signature_text = token.split(".", maxsplit=1)
        encoded = encoded_text.encode()
        signature = base64.urlsafe_b64decode(
            signature_text + "=" * (-len(signature_text) % 4),
        )
        expected = hmac.new(
            request.app.state.validation_secret,
            encoded,
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("invalid signature")
        raw = base64.urlsafe_b64decode(
            encoded_text + "=" * (-len(encoded_text) % 4),
        )
        payload = json.loads(raw)
        valid = (
            payload.get("integrationId") == integration_id
            and payload.get("digest") == digest
            and int(payload.get("expiresAt", 0)) >= int(time.time())
        )
        if not valid:
            raise ValueError("validation receipt does not match")
    except (TypeError, ValueError, KeyError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "validation_required",
                "message": "test the current credentials before saving",
            },
        ) from exc


def _llm_spec_or_404(provider: str) -> ProviderSpec:
    try:
        return provider_spec(provider)
    except LLMRouteError as exc:
        raise HTTPException(
            status_code=404,
            detail="unknown LLM provider",
        ) from exc


def _validate_llm_candidate(
    provider: str,
    candidate: LLMIntegrationCandidate,
) -> tuple[LLMIntegrationCandidate, ProviderSpec]:
    spec = _llm_spec_or_404(provider)
    if candidate.model not in spec.models:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "model_not_allowed",
                "message": (f"model is not in the approved {spec.label} model list"),
            },
        )
    return (
        LLMIntegrationCandidate(
            api_key=candidate.api_key,
            model=candidate.model,
        ),
        spec,
    )


@router.get("/v1/profile", response_model=UserProfile)
def get_profile(request: Request) -> UserProfile:
    return app_service(request, "settings_repository").get_profile()


@router.patch(
    "/v1/profile",
    response_model=UserProfile,
    dependencies=[Depends(require_write_auth)],
)
def update_profile(
    request_body: UserProfilePatch,
    request: Request,
) -> UserProfile:
    try:
        return app_service(request, "settings_repository").update_profile(
            request_body,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/v1/settings/integrations", response_model=IntegrationOverview)
def get_integrations(request: Request) -> IntegrationOverview:
    return _integration_overview(request)


@router.get("/v1/settings/automation", response_model=AutomationSettings)
def get_automation_settings(request: Request) -> AutomationSettings:
    return _automation_settings(request)


@router.put(
    "/v1/settings/automation",
    response_model=AutomationSettings,
    dependencies=[Depends(require_write_auth)],
)
def update_automation_settings(
    request_body: AutomationSettingsUpdate,
    request: Request,
) -> AutomationSettings:
    repository = app_service(request, "settings_repository")
    try:
        saved = repository.update_automation_preferences(request_body)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    app_service(request, "scheduler").configure(enabled=saved.research_enabled)
    app_service(request, "intraday_scheduler").configure(enabled=saved.live_enabled)
    app_service(request, "performance_scheduler").configure(enabled=saved.performance_enabled)
    return _automation_settings(request)


@router.put(
    "/v1/settings/cfd",
    response_model=CfdImportStatus,
    dependencies=[Depends(require_write_auth)],
)
def update_cfd_account_preference(
    request_body: CfdAccountPreferenceUpdate,
    request: Request,
) -> CfdImportStatus:
    imports = app_service(request, "cfd_imports")
    try:
        return CfdImportStatus.model_validate(
            imports.set_account_status(request_body.account_status)
        )
    except (OSError, RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get(
    "/v1/valuation/assumptions",
    response_model=ValuationAssumptionsState,
)
def get_valuation_assumptions(request: Request) -> ValuationAssumptionsState:
    return app_service(request, "valuation_assumptions").load()


@router.get(
    "/v1/valuation/assumptions/history",
    response_model=list[ValuationAssumptionsHistoryEntry],
)
def get_valuation_assumptions_history(
    request: Request,
    limit: int = Query(default=100, ge=1, le=500),
) -> list[ValuationAssumptionsHistoryEntry]:
    return app_service(request, "valuation_assumptions").history(limit)


@router.put(
    "/v1/valuation/assumptions/{ticker}",
    response_model=ValuationAssumptionsState,
    dependencies=[Depends(require_write_auth)],
)
def upsert_valuation_assumptions(
    ticker: str,
    request_body: ValuationAssumptionsUpsertRequest,
    request: Request,
) -> ValuationAssumptionsState:
    if not ticker.strip():
        raise HTTPException(status_code=422, detail="ticker is required")
    return app_service(request, "valuation_assumptions").upsert(
        ticker.strip().upper(),
        request_body,
    )


@router.put(
    "/v1/settings/integrations/trading212/{profile}",
    response_model=IntegrationSummary,
    dependencies=[Depends(require_write_auth)],
)
def rotate_trading212(
    profile: str,
    request_body: Trading212IntegrationRequest,
    request: Request,
) -> IntegrationSummary:
    normalized = profile.strip().lower()
    if normalized not in {"invest", "isa"}:
        raise HTTPException(
            status_code=404,
            detail="unknown Trading 212 profile",
        )
    candidate = Trading212IntegrationCandidate(
        api_key_id=request_body.api_key_id,
        secret_key=request_body.secret_key,
        environment=request_body.environment,
    )
    _require_validation_token(
        request,
        integration_id=f"trading212:{normalized}",
        digest=_candidate_digest(candidate),
        token=request_body.validation_token,
    )
    preferences = app_service(request, "settings_repository")
    reference = preferences.credential_reference("trading212", normalized)
    secret = json.dumps(
        {
            "api_key": request_body.api_key_id,
            "api_secret": request_body.secret_key,
        },
        separators=(",", ":"),
    )
    app_service(request, "credential_store").put(reference, secret)
    return preferences.save_integration(
        provider="trading212",
        profile=normalized,
        enabled=request_body.enabled,
        model=None,
        base_url=None,
        credential_fingerprint=secret_fingerprint(secret),
        test_status="succeeded",
    )


@router.post(
    "/v1/settings/integrations/trading212/{profile}/test",
    response_model=IntegrationTestResult,
    dependencies=[Depends(require_write_auth)],
)
def test_trading212(
    profile: str,
    request_body: Trading212IntegrationCandidate,
    request: Request,
) -> IntegrationTestResult:
    normalized = profile.strip().lower()
    if normalized not in {"invest", "isa"}:
        raise HTTPException(
            status_code=404,
            detail="unknown Trading 212 profile",
        )
    try:
        message = _test_trading212(
            normalized,
            api_key_id=request_body.api_key_id,
            secret_key=request_body.secret_key,
            environment=request_body.environment,
        )
    except Exception as exc:
        raise _safe_integration_error(exc) from exc
    integration_id = f"trading212:{normalized}"
    return IntegrationTestResult(
        integration_id=integration_id,
        status="succeeded",
        tested_at=datetime.now(UTC),
        message=message,
        validation_token=_validation_token(
            request,
            integration_id=integration_id,
            digest=_candidate_digest(request_body),
        ),
    )


@router.delete(
    "/v1/settings/integrations/trading212/{profile}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_write_auth)],
)
def delete_trading212(profile: str, request: Request) -> None:
    normalized = profile.strip().lower()
    preferences = app_service(request, "settings_repository")
    reference = preferences.credential_reference("trading212", normalized)
    try:
        app_service(request, "credential_store").delete(reference)
    except CredentialStoreError as exc:
        raise _safe_integration_error(exc) from exc
    preferences.remove_integration(
        provider="trading212",
        profile=normalized,
    )


@router.put(
    "/v1/settings/integrations/deepseek",
    response_model=IntegrationSummary,
    dependencies=[Depends(require_write_auth)],
)
def rotate_deepseek(
    request_body: DeepSeekIntegrationRequest,
    request: Request,
) -> IntegrationSummary:
    if request_body.model not in ALLOWED_DEEPSEEK_MODELS:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "model_not_allowed",
                "message": "model is not in the approved DeepSeek model list",
            },
        )
    base_url = _provider_url(request_body.base_url, provider="deepseek")
    candidate = DeepSeekIntegrationCandidate(
        api_key=request_body.api_key,
        model=request_body.model,
        base_url=base_url,
    )
    _require_validation_token(
        request,
        integration_id="deepseek:default",
        digest=_candidate_digest(candidate),
        token=request_body.validation_token,
    )
    preferences = app_service(request, "settings_repository")
    reference = preferences.credential_reference("deepseek")
    app_service(request, "credential_store").put(
        reference,
        request_body.api_key,
    )
    return preferences.save_integration(
        provider="deepseek",
        profile=None,
        enabled=request_body.enabled,
        model=request_body.model,
        base_url=base_url,
        credential_fingerprint=secret_fingerprint(request_body.api_key),
        test_status="succeeded",
    )


@router.post(
    "/v1/settings/integrations/deepseek/test",
    response_model=IntegrationTestResult,
    dependencies=[Depends(require_write_auth)],
)
def test_deepseek(
    request_body: DeepSeekIntegrationCandidate,
    request: Request,
) -> IntegrationTestResult:
    if request_body.model not in ALLOWED_DEEPSEEK_MODELS:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "model_not_allowed",
                "message": "model is not in the approved DeepSeek model list",
            },
        )
    base_url = _provider_url(request_body.base_url, provider="deepseek")
    candidate = DeepSeekIntegrationCandidate(
        api_key=request_body.api_key,
        model=request_body.model,
        base_url=base_url,
    )
    try:
        message = _check_deepseek_connection(
            api_key=request_body.api_key,
            model=request_body.model,
            base_url=base_url,
        )
    except Exception as exc:
        raise _safe_integration_error(exc) from exc
    return IntegrationTestResult(
        integration_id="deepseek:default",
        status="succeeded",
        tested_at=datetime.now(UTC),
        message=message,
        model=request_body.model,
        validation_token=_validation_token(
            request,
            integration_id="deepseek:default",
            digest=_candidate_digest(candidate),
        ),
    )


@router.delete(
    "/v1/settings/integrations/deepseek",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_write_auth)],
)
def delete_deepseek(request: Request) -> None:
    preferences = app_service(request, "settings_repository")
    try:
        app_service(request, "credential_store").delete(
            preferences.credential_reference("deepseek"),
        )
    except CredentialStoreError as exc:
        raise _safe_integration_error(exc) from exc
    preferences.remove_integration(provider="deepseek", profile=None)


@router.get(
    "/v1/settings/llm/providers",
    response_model=LLMProvidersResponse,
)
def get_llm_providers(request: Request) -> LLMProvidersResponse:
    preferences = app_service(request, "settings_repository")
    return LLMProvidersResponse(
        providers=[LLMProviderDescriptor.model_validate(item) for item in provider_routes()],
        integrations=[
            item
            for item in _integration_overview(request).integrations
            if item.provider in PROVIDER_REGISTRY
        ],
        route_policy=preferences.get_route_policy(),
    )


@router.get("/v1/settings/llm/routes", response_model=LLMRoutePolicy)
@router.get("/v1/settings/llm/route-policy", response_model=LLMRoutePolicy)
def get_llm_route_policy(request: Request) -> LLMRoutePolicy:
    return app_service(request, "settings_repository").get_route_policy()


@router.put(
    "/v1/settings/llm/routes",
    response_model=LLMRoutePolicy,
    dependencies=[Depends(require_write_auth)],
)
@router.put(
    "/v1/settings/llm/route-policy",
    response_model=LLMRoutePolicy,
    dependencies=[Depends(require_write_auth)],
)
def update_llm_route_policy(
    request_body: LLMRoutePolicyUpdate,
    request: Request,
) -> LLMRoutePolicy:
    try:
        return app_service(request, "settings_repository").save_route_policy(
            request_body,
        )
    except ValueError as exc:
        code = (
            "route_policy_conflict" if "revision conflict" in str(exc) else "invalid_route_policy"
        )
        raise HTTPException(
            status_code=409 if code == "route_policy_conflict" else 422,
            detail={"code": code, "message": str(exc)},
        ) from exc


@router.post(
    "/v1/settings/llm/providers/{provider}/test",
    response_model=IntegrationTestResult,
    dependencies=[Depends(require_write_auth)],
)
def test_llm_provider(
    provider: str,
    request_body: LLMIntegrationCandidate,
    request: Request,
) -> IntegrationTestResult:
    candidate, spec = _validate_llm_candidate(provider, request_body)
    try:
        if spec.provider == "deepseek":
            message = _check_deepseek_connection(
                api_key=candidate.api_key,
                model=candidate.model,
                base_url=spec.base_url,
            )
        else:
            message = _check_openai_compatible_connection(
                api_key=candidate.api_key,
                model=candidate.model,
                base_url=spec.base_url,
                provider_label=spec.label,
            )
    except Exception as exc:
        raise _safe_integration_error(exc) from exc
    preferences = app_service(request, "settings_repository")
    integration_id = preferences.credential_reference(spec.provider)
    return IntegrationTestResult(
        integration_id=integration_id,
        status="succeeded",
        tested_at=datetime.now(UTC),
        message=message,
        model=candidate.model,
        validation_token=_validation_token(
            request,
            integration_id=integration_id,
            digest=_candidate_digest(candidate),
        ),
    )


@router.put(
    "/v1/settings/llm/providers/{provider}",
    response_model=IntegrationSummary,
    dependencies=[Depends(require_write_auth)],
)
def save_llm_provider(
    provider: str,
    request_body: LLMIntegrationRequest,
    request: Request,
) -> IntegrationSummary:
    candidate, spec = _validate_llm_candidate(provider, request_body)
    preferences = app_service(request, "settings_repository")
    integration_id = preferences.credential_reference(spec.provider)
    _require_validation_token(
        request,
        integration_id=integration_id,
        digest=_candidate_digest(candidate),
        token=request_body.validation_token,
    )
    try:
        app_service(request, "credential_store").put(
            integration_id,
            candidate.api_key,
        )
    except CredentialStoreError as exc:
        raise _safe_integration_error(exc) from exc
    return preferences.save_integration(
        provider=spec.provider,
        profile=None,
        enabled=request_body.enabled,
        model=candidate.model,
        base_url=spec.base_url,
        credential_fingerprint=secret_fingerprint(candidate.api_key),
        test_status="succeeded",
    )


@router.delete(
    "/v1/settings/llm/providers/{provider}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_write_auth)],
)
def delete_llm_provider(provider: str, request: Request) -> None:
    spec = _llm_spec_or_404(provider)
    preferences = app_service(request, "settings_repository")
    try:
        app_service(request, "credential_store").delete(
            preferences.credential_reference(spec.provider),
        )
    except CredentialStoreError as exc:
        raise _safe_integration_error(exc) from exc
    preferences.remove_integration(provider=spec.provider, profile=None)
