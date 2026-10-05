"""Signing boundaries use synthetic bundles and mocked Keychain/system commands."""

import importlib.util
import json
import plistlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("packaging_script", SCRIPTS / "package_macos.py")
packaging = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packaging)
IDENTITY = "A" * 40


def fixture(root):
    app = root / "Synthetic.app"
    for relative in [
        packaging.NODE,
        Path("Contents/MacOS/synthetic"),
        Path("Contents/Resources/runtime/python/bin/python3.12"),
        Path("Contents/Resources/runtime/extension.without-known-suffix"),
    ]:
        path = app / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes.fromhex("cffaedfe") + b"synthetic Mach-O")
    (app / "Contents/Info.plist").write_bytes(
        plistlib.dumps(
            {
                "CFBundleIdentifier": packaging.BUNDLE,
                "CFBundleShortVersionString": "1.11.0",
                "LSMinimumSystemVersion": "13.0",
                "CFBundleExecutable": "synthetic",
            }
        )
    )
    (app / "Contents/Resources/runtime/build-info.json").write_text(
        json.dumps({"product_version": "1.11.0"})
    )
    return app


class PackagingTests(unittest.TestCase):
    def test_wrong_version_and_escaping_links_stop_before_key_access(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(packaging, "run") as run:
            root = Path(temporary)
            app = fixture(root)
            with self.assertRaises(ValueError):
                packaging.prepare(app, root / "out", IDENTITY, "1.12.0")
            (app / "outside").symlink_to(root)
            with self.assertRaises(ValueError):
                packaging.prepare(app, root / "out", IDENTITY, "1.11.0")
            run.assert_not_called()
            self.assertFalse((root / "out").exists())

    def test_public_signing_cannot_use_development_or_other_team(self):
        for name in [
            "Apple Development: Synthetic",
            "Developer ID Application: Other (OTHERTEAM1)",
        ]:
            with (
                patch.object(packaging, "run", return_value=f'1) {IDENTITY} "{name}"'),
                self.assertRaises(ValueError),
            ):
                packaging.identity_name(IDENTITY)
        with patch.object(packaging, "run") as run:
            with self.assertRaises(ValueError):
                packaging.identity_name("not a certificate fingerprint")
            run.assert_not_called()

    def test_existing_output_and_recursive_copy_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(packaging, "identity_name"):
            root = Path(temporary)
            app = fixture(root)
            existing = root / "out"
            existing.mkdir()
            (existing / "keep").write_text("existing release evidence")
            for output in [existing, app / "recursive"]:
                with self.assertRaises(ValueError):
                    packaging.prepare(app, output, IDENTITY, "1.11.0")
            self.assertEqual((existing / "keep").read_text(), "existing release evidence")
            self.assertFalse((app / "recursive").exists())

    def test_every_native_component_is_signed_but_only_node_gets_jit(self):
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(packaging, "identity_name"),
            patch.object(packaging, "check_native_compatibility"),
        ):
            root = Path(temporary)
            app = fixture(root)
            output = root / "out"
            original = (app / "Contents/MacOS/synthetic").read_bytes()
            signed = {}
            calls = []

            def fake(*args, **kwargs):
                calls.append(args)
                if args[0] == "/usr/bin/ditto":
                    shutil.copytree(args[1], args[2])
                if "--sign" in args:
                    self.assertNotIn("--deep", args)
                    signed[args[-1]] = plistlib.loads(
                        args[args.index("--entitlements") + 1].read_bytes()
                    )
                if "--display" in args and "--entitlements" in args:
                    self.assertIn("--xml", args)
                    value = signed[args[-1]]
                    return plistlib.dumps(value).decode() if value else ""
                return f"Authority=Apple Development: Synthetic\nTeamIdentifier={packaging.TEAM}\nCodeDirectory flags=0x10000(runtime)"

            with patch.object(packaging, "run", side_effect=fake):
                result = packaging.prepare(app, output, IDENTITY, "1.11.0", rehearsal=True)
            copied = output / app.name
            self.assertEqual(len(signed), 5)  # Four native files and the outer App.
            self.assertEqual(signed[copied / packaging.NODE], packaging.JIT)
            self.assertTrue(
                all(not value for path, value in signed.items() if path != copied / packaging.NODE)
            )
            self.assertEqual((app / "Contents/MacOS/synthetic").read_bytes(), original)
            self.assertIsNone(result["archive"])
            self.assertTrue(result["internal_rehearsal"])
            self.assertFalse(list(output.glob("*.zip")))

    def test_newer_os_dependency_stops_before_signing_or_copying(self):
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(packaging, "identity_name") as identity,
            patch.object(packaging, "run") as run,
            patch.object(
                packaging, "check_native_compatibility", side_effect=ValueError("requires macOS 14")
            ),
        ):
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "requires macOS 14"):
                packaging.prepare(fixture(root), root / "out", IDENTITY, "1.11.0")
            identity.assert_not_called()
            run.assert_not_called()
            self.assertFalse((root / "out").exists())

    def test_unsafe_entitlements_and_missing_timestamp_are_rejected(self):
        for unsafe in [
            {"com.apple.security.get-task-allow": True},
            {"com.apple.security.cs.disable-library-validation": True},
        ]:

            def fake(*args, unsafe=unsafe, **kwargs):
                if "--entitlements" in args:
                    return plistlib.dumps(unsafe).decode()
                return f"Authority=Developer ID Application: Synthetic\nTeamIdentifier={packaging.TEAM}\nCodeDirectory flags=0x10000(runtime)\nTimestamp=synthetic"

            with patch.object(packaging, "run", side_effect=fake), self.assertRaises(ValueError):
                packaging.verify_code(Path("Synthetic"), rehearsal=False, entitlements={})
        details = f"Authority=Developer ID Application: Synthetic\nTeamIdentifier={packaging.TEAM}\nCodeDirectory flags=0x10000(runtime)"
        with patch.object(packaging, "run", return_value=details), self.assertRaises(ValueError):
            packaging.verify_code(Path("Synthetic"), rehearsal=False, entitlements={})

    def test_unnotarized_app_cannot_be_packaged_as_dmg(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(packaging, "identity_name"):
            root = Path(temporary)
            app = fixture(root)
            with (
                patch.object(packaging, "check_signature", side_effect=ValueError("not stapled")),
                patch.object(packaging, "run") as run,
                self.assertRaises(ValueError),
            ):
                packaging.make_dmg(
                    app, root / "trading-max-v1.11.0-macos-arm64.dmg", IDENTITY, "1.11.0"
                )
            run.assert_not_called()
            self.assertFalse(list(root.glob("*.dmg")))

    def test_dmg_contains_only_app_and_install_shortcut_and_never_overwrites(self):
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(packaging, "identity_name"),
            patch.object(packaging, "check_signature") as signature,
            patch.object(packaging, "check_native_compatibility"),
        ):
            root = Path(temporary)
            app = fixture(root)
            output = root / "trading-max-v1.11.0-macos-arm64.dmg"

            def fake(*args, **kwargs):
                if args[0] == "/usr/bin/ditto":
                    shutil.copytree(args[1], args[2])
                if args[0] == "/usr/bin/hdiutil":
                    stage = args[args.index("-srcfolder") + 1]
                    self.assertEqual({p.name for p in stage.iterdir()}, {app.name, "Applications"})
                    self.assertEqual((stage / "Applications").readlink(), Path("/Applications"))
                    self.assertEqual(args[args.index("-format") + 1], "UDZO")
                    output.write_bytes(b"synthetic compressed image")
                return ""

            with patch.object(packaging, "run", side_effect=fake):
                result = packaging.make_dmg(app, output, IDENTITY, "1.11.0")
            signature.assert_called_once_with(app, app=True)
            self.assertFalse(result["notarized"])
            with patch.object(packaging, "run") as run, self.assertRaises(ValueError):
                packaging.make_dmg(app, output, IDENTITY, "1.11.0")
            run.assert_not_called()
            self.assertEqual(output.read_bytes(), b"synthetic compressed image")


if __name__ == "__main__":
    unittest.main()
