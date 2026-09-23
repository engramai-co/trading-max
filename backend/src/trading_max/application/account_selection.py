"""Immutable account selection shared by every stage of one refresh."""

from trading_max.infrastructure import ContentAddressedArtifactStore

from .errors import StageExecutionError
from .stages import StageContext

ACCOUNT_PROFILES = (("A", "invest"), ("B", "isa"))
SELECTION_KEY = "account/selection.json"


def accounts_for_profiles(profiles) -> tuple[tuple[str, str], ...]:
    if (
        not isinstance(profiles, (list, tuple))
        or not profiles
        or any(
            not isinstance(profile, str) or profile not in {"invest", "isa"} for profile in profiles
        )
        or len(set(profiles)) != len(profiles)
    ):
        raise StageExecutionError(
            "account.selection_invalid", "connect at least one valid account before syncing"
        )
    return tuple((code, profile) for code, profile in ACCOUNT_PROFILES if profile in profiles)


def selected_accounts(
    artifacts: ContentAddressedArtifactStore,
    context: StageContext,
    default: tuple[tuple[str, str], ...] = ACCOUNT_PROFILES,
) -> tuple[tuple[str, str], ...]:
    for artifact_id in reversed(context.upstream_artifact_ids):
        try:
            ref = artifacts.get_ref(artifact_id)
        except FileNotFoundError:
            continue
        if ref.key != SELECTION_KEY:
            continue
        profiles = artifacts.get_json(artifact_id).payload.get("profiles")
        return accounts_for_profiles(profiles)
    # Legacy snapshots and explicit stage fixtures predate the selection artifact.
    return default
