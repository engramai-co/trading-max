"""Synthetic distribution fixtures; real signing is a separate release gate."""

import importlib.util
import json
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "distribution", Path(__file__).parents[1] / "scripts/verify_distribution.py"
)
distribution = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(distribution)


class DistributionTests(unittest.TestCase):
    def test_ad_hoc_and_another_developer_are_not_publishable(self):
        for identity in [
            "Signature=adhoc",
            "Authority=Apple Development: Synthetic",
            "Authority=Developer ID Application: Other\nTeamIdentifier=OTHERTEAM1",
        ]:
            with (
                patch.object(distribution, "run", return_value=identity),
                self.assertRaises(ValueError),
            ):
                distribution.check_signature(Path("synthetic.app"), app=True)

    def test_signed_but_not_notarized_package_stops(self):
        def fake(*args):
            if "stapler" in args:
                raise subprocess.CalledProcessError(65, "synthetic-stapler")
            return f"Authority=Developer ID Application: Synthetic\nTeamIdentifier={distribution.TEAM}\nCodeDirectory flags=0x10000(runtime)"

        with (
            patch.object(distribution, "run", side_effect=fake),
            self.assertRaises(subprocess.CalledProcessError),
        ):
            distribution.check_signature(Path("synthetic.app"), app=True)

    def test_dmg_contents_are_checked_and_detached_on_failure(self):
        for fail in [None, "version", "runtime", "arch", "extra-app", "native-os"]:
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as temporary:
                dmg = Path(temporary) / "trading-max-v1.11.0-macos-arm64.dmg"
                dmg.write_bytes(b"synthetic-dmg")
                commands = []

                def fake(*args, commands=commands, fail=fail):
                    commands.append(args)
                    if "attach" in args:
                        mount = args[args.index("-mountpoint") + 1]
                        app = mount / "Synthetic.app"
                        (app / "Contents/Resources/runtime").mkdir(parents=True)
                        (app / "Contents/Info.plist").write_bytes(
                            plistlib.dumps(
                                {
                                    "CFBundleIdentifier": distribution.BUNDLE,
                                    "CFBundleShortVersionString": "1.10.0"
                                    if fail == "version"
                                    else "1.11.0",
                                    "LSMinimumSystemVersion": "13.0",
                                    "CFBundleExecutable": "synthetic",
                                }
                            )
                        )
                        (app / "Contents/Resources/runtime/build-info.json").write_text(
                            json.dumps(
                                {"product_version": "1.10.0" if fail == "runtime" else "1.11.0"}
                            )
                        )
                        if fail == "extra-app":
                            (mount / "Other.app").mkdir()
                    if "-archs" in args:
                        return "x86_64" if fail == "arch" else "arm64"
                    return f"Authority=Developer ID Application: Synthetic\nTeamIdentifier={distribution.TEAM}\nCodeDirectory flags=0x10000(runtime)"

                with (
                    patch.object(distribution, "run", side_effect=fake),
                    patch.object(
                        distribution,
                        "check_native_compatibility",
                        side_effect=ValueError("requires macOS 14")
                        if fail == "native-os"
                        else None,
                    ),
                ):
                    if fail:
                        with self.assertRaises(ValueError):
                            distribution.verify(dmg, "1.11.0")
                    else:
                        result = distribution.verify(dmg, "1.11.0")
                        self.assertEqual(result["asset"]["size"], len(b"synthetic-dmg"))
                        self.assertEqual(len(result["asset"]["sha256"]), 64)
                self.assertTrue(any("detach" in args for args in commands))

    def test_unexpected_file_and_symlink_are_rejected_before_system_tools(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(distribution, "run") as run:
            original = Path(temporary) / "other.dmg"
            original.write_bytes(b"synthetic")
            link = original.with_name("trading-max-v1.11.0-macos-arm64.dmg")
            link.symlink_to(original)
            for path in [original, link]:
                with self.assertRaises(ValueError):
                    distribution.verify(path, "1.11.0")
            run.assert_not_called()
