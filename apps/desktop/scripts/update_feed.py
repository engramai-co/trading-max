"""Create a signed Sparkle appcast for a verified DMG. Keys never leave Keychain."""

from __future__ import annotations

import base64
import json
import plistlib
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

from prepare_sparkle import DESKTOP, LOCK, prepare, sha256
from verify_distribution import BUNDLE, MINIMUM_MACOS, SEMVER, TEAM

ORIGIN = "https://github.com/engramai-co/trading-max/releases/download"
SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle"
ET.register_namespace("sparkle", SPARKLE)


def command(*args: str | Path) -> str:
    return subprocess.check_output(  # noqa: S603 - fixed SDK commands; no secret arguments
        [str(arg) for arg in args], text=True, timeout=90
    ).strip()


def validate_manifest(dmg: Path, manifest: dict, version: str) -> None:
    if not SEMVER.fullmatch(version):
        raise ValueError("Invalid release version")
    expected = f"trading-max-v{version}-macos-arm64.dmg"
    if (
        dmg.name != expected
        or dmg.is_symlink()
        or manifest.get("schema") != 1
        or manifest.get("version") != version
        or manifest.get("bundle_id") != BUNDLE
        or manifest.get("team_id") != TEAM
        or manifest.get("signing") != "Developer ID Application"
        or manifest.get("notarized") is not True
        or manifest.get("target") != "macos-arm64"
        or manifest.get("minimum_macos") != MINIMUM_MACOS
        or manifest.get("asset")
        != {"name": expected, "size": dmg.stat().st_size, "sha256": sha256(dmg)}
    ):
        raise ValueError("DMG differs from its verified distribution manifest")


def xml_bytes(version: str, size: int, signature: str) -> bytes:
    if (
        not SEMVER.fullmatch(version)
        or not 0 < size <= 2_147_483_648
        or len(base64.b64decode(signature, validate=True)) != 64
    ):
        raise ValueError("Invalid appcast version or Ed25519 signature")
    rss = ET.Element("rss", {"version": "2.0"})
    channel = ET.SubElement(rss, "channel")
    ET.SubElement(channel, "title").text = "Trading Max desktop updates"
    item = ET.SubElement(channel, "item")
    ET.SubElement(item, "title").text = f"Trading Max {version}"
    ET.SubElement(item, f"{{{SPARKLE}}}version").text = version
    ET.SubElement(item, f"{{{SPARKLE}}}shortVersionString").text = version
    ET.SubElement(item, f"{{{SPARKLE}}}minimumSystemVersion").text = MINIMUM_MACOS
    ET.SubElement(
        item,
        "enclosure",
        {
            "url": f"{ORIGIN}/v{version}/trading-max-v{version}-macos-arm64.dmg",
            "length": str(size),
            "type": "application/octet-stream",
            f"{{{SPARKLE}}}edSignature": signature,
            f"{{{SPARKLE}}}os": "macos",
        },
    )
    ET.indent(rss)
    return ET.tostring(rss, encoding="utf-8", xml_declaration=True) + b"\n"


def signing_tools() -> tuple[Path, str]:
    sdk = prepare()
    account = json.loads(LOCK.read_text())["keychain_account"]
    public_key = command(sdk / "bin/generate_keys", "--account", account, "-p")
    info = plistlib.loads((DESKTOP / "src-tauri/Info.plist").read_bytes())
    if public_key != info["SUPublicEDKey"]:
        raise ValueError("Keychain update identity does not match the embedded public key")
    return sdk / "bin/sign_update", account


def verify_existing(dmg: Path, manifest_path: Path, output: Path) -> None:
    """Adopt a completed feed after interruption only after independent verification."""
    manifest = json.loads(manifest_path.read_text())
    version = manifest["version"]
    validate_manifest(dmg, manifest, version)
    if output.is_symlink() or not 0 < output.stat().st_size <= 16_384:
        raise ValueError("Invalid appcast file")
    data = output.read_bytes().decode("utf-8")
    if "<!DOCTYPE" in data or "<!ENTITY" in data or "\x00" in data:
        raise ValueError("Appcast must not contain external entities")
    root = ET.fromstring(data)  # noqa: S314 - bounded UTF-8, DTD/entities rejected above
    enclosure = root.find("./channel/item/enclosure")
    if enclosure is None:
        raise ValueError("Appcast has no update")
    signature = enclosure.get(f"{{{SPARKLE}}}edSignature", "")
    expected = ET.fromstring(xml_bytes(version, dmg.stat().st_size, signature))  # noqa: S314 - generated XML
    if ET.tostring(root) != ET.tostring(expected):
        raise ValueError("Appcast differs from the accepted release")
    signer, account = signing_tools()
    command(signer, "--account", account, "--verify", output)
    command(signer, "--account", account, "--verify", dmg, signature)


def create(dmg: Path, manifest_path: Path, output: Path) -> Path:
    manifest = json.loads(manifest_path.read_text())
    version = manifest["version"]
    validate_manifest(dmg, manifest, version)
    if output.name != f"trading-max-v{version}-macos-arm64.xml" or output.exists():
        raise ValueError("Use a new correctly named appcast; existing feeds are immutable")
    signer, account = signing_tools()
    signature = command(signer, "--account", account, "-p", dmg)
    command(signer, "--account", account, "--verify", dmg, signature)
    with tempfile.TemporaryDirectory(prefix="feed-", dir=output.parent) as temporary:
        feed = Path(temporary) / output.name
        feed.write_bytes(xml_bytes(version, dmg.stat().st_size, signature))
        command(signer, "--account", account, feed)
        command(signer, "--account", account, "--verify", feed)
        feed.rename(output)
    return output
