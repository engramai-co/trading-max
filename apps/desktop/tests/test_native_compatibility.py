"""Portable desktop bundles must match the promised OS, independent of the build host."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import prepare_payload
import verify_distribution as distribution

BUILD = """Synthetic (architecture arm64):
Load command 0
      cmd LC_BUILD_VERSION
 platform 1
    minos 13.0
      sdk 26.5
   ntools 1
     tool LD
  version 1267.0
"""


class NativeCompatibilityTests(unittest.TestCase):
    def test_deployment_version_is_not_the_sdk_or_linker_version(self):
        distribution.check_load_commands(BUILD)
        distribution.check_load_commands(
            "Load command 0\n cmd LC_VERSION_MIN_MACOSX\n version 12.0\n sdk 26.5\n"
        )
        with self.assertRaisesRegex(ValueError, "newer macOS"):
            distribution.check_load_commands(BUILD.replace("minos 13.0", "minos 14.0"))
        for output in ["", BUILD.replace("minos 13.0", "minos unknown")]:
            with self.assertRaises(ValueError):
                distribution.check_load_commands(output)
        with self.assertRaisesRegex(ValueError, "target macOS"):
            distribution.check_load_commands(BUILD.replace("platform 1", "platform 2"))

    def test_external_dependencies_are_rejected_but_self_id_is_not_a_dependency(self):
        for command, field in [("LC_LOAD_DYLIB", "name"), ("LC_RPATH", "path")]:
            with self.subTest(command=command), self.assertRaisesRegex(ValueError, "absolute path"):
                distribution.check_load_commands(
                    BUILD
                    + f"Load command 1\n cmd {command}\n {field} /opt/homebrew/lib/local.dylib (offset 24)\n"
                )
        distribution.check_load_commands(
            BUILD
            + "Load command 1\n cmd LC_ID_DYLIB\n name /synthetic/build/lib.dylib (offset 24)\n"
        )
        distribution.check_load_commands(
            BUILD + "Load command 1\n cmd LC_LOAD_DYLIB\n name @rpath/lib.dylib (offset 24)\n"
        )

    def test_scan_includes_native_extensions_without_relying_on_suffixes(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary)
            (app / "native-extension").write_bytes(bytes.fromhex("cffaedfe") + b"synthetic")
            (app / "document.txt").write_text("not executable")
            with patch.object(distribution, "run", side_effect=["arm64", BUILD]):
                self.assertEqual(distribution.check_native_compatibility(app), 1)
            with (
                patch.object(distribution, "run", return_value="x86_64"),
                self.assertRaisesRegex(ValueError, "Missing arm64"),
            ):
                distribution.check_native_compatibility(app)
            (app / "escaping").symlink_to(app.parent)
            with (
                patch.object(distribution, "run", side_effect=["arm64", BUILD]),
                self.assertRaisesRegex(ValueError, "escaping"),
            ):
                distribution.check_native_compatibility(app)

    def test_wheel_selection_overrides_newer_build_host_and_keeps_hashes(self):
        with (
            patch.dict(os.environ, {"MACOSX_DEPLOYMENT_TARGET": "26.0"}),
            patch.object(prepare_payload, "run") as run,
        ):
            prepare_payload.install_python_dependencies(
                Path("synthetic/python"), Path("synthetic/site"), Path("synthetic/requirements")
            )
            args = run.call_args.args
            self.assertEqual(args[args.index("--python-platform") + 1], "aarch64-apple-darwin")
            self.assertEqual(args[args.index("--only-binary") + 1], ":all:")
            self.assertIn("--require-hashes", args)
            self.assertEqual(run.call_args.kwargs["env"]["MACOSX_DEPLOYMENT_TARGET"], "13.0")
            self.assertEqual(os.environ["MACOSX_DEPLOYMENT_TARGET"], "26.0")


if __name__ == "__main__":
    unittest.main()
