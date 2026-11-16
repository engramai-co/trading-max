"""Node process lookup and environment for ChatGPT device-code login only."""

import os
import shutil
from pathlib import Path

PI_ROOT = Path(__file__).resolve().parents[1] / "synthesis" / "_pi"


def node_executable() -> str:
    """Return the bundled or foreground Node executable."""
    # Production pins Node next to its release; foreground development uses PATH.
    for parent in Path(__file__).resolve().parents:
        pinned = parent / ".node-runtime" / "node"
        if pinned.is_file():
            return str(pinned)
    return shutil.which("node") or "node"


def bridge_environment() -> dict[str, str]:
    """Do not inherit unrelated provider keys or Node preload hooks."""
    return {
        key: value
        for key, value in os.environ.items()
        if key
        in {
            "PATH",
            "LANG",
            "LC_ALL",
            "TZ",
            "SYSTEMROOT",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "NODE_EXTRA_CA_CERTS",
        }
    }
