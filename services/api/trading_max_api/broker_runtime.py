"""Resolve explicit broker connections when a refresh actually starts."""

import os


def broker_profiles_loader(preferences):
    def profiles():
        integrations = [
            item for item in preferences.list_integrations() if item.provider == "trading212"
        ]
        configured = [item for item in integrations if item.configured]
        if not configured and not os.environ.get("TRADING_MAX_DESKTOP_WORKSPACE_ID"):
            return ("invest", "isa")  # Existing source/Keychain installations.
        return tuple(
            sorted(item.profile for item in configured if item.enabled and not item.needs_secret)
        )

    return profiles
