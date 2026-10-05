"""Interrupted release jobs reuse receipts; no production services or signing keys."""

import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import prepare_sparkle as sdk
import release_macos as pipeline
import update_feed as feed


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.lock = (self.root / "lock").open("w")
        self.addCleanup(self.lock.close)
        self.config = {"notary_profile": "SyntheticProfile"}
        with patch.object(pipeline, "git", return_value="synthetic-source"):
            self.release = pipeline.Release(self.root, self.lock, self.config)
        self.archive = self.root / "synthetic.zip"
        self.archive.write_bytes(b"synthetic signed archive")

    def test_resume_queries_saved_submission_without_uploading_again(self):
        calls = []

        def command(name, args, **kwargs):
            calls.append(name)
            if name.endswith("submit"):
                return json.dumps({"id": "saved-id", "message": "Successfully uploaded file"})
            return json.dumps({"id": "saved-id", "status": "In Progress"})

        with (
            patch.object(self.release, "command", side_effect=command),
            self.assertRaises(pipeline.Pending),
        ):
            self.release.notarize("app", self.archive)
        resumed = pipeline.Release(self.root, self.lock)
        with (
            patch.object(resumed, "command", side_effect=command),
            self.assertRaises(pipeline.Pending),
        ):
            resumed.notarize("app", self.archive)
        self.assertEqual(calls.count("notary-app-submit"), 1)
        self.assertEqual(calls.count("notary-app-info"), 2)

    def test_completed_upload_receipt_survives_driver_interruption(self):
        receipt = self.root / "submit.stdout"
        receipt.write_text(json.dumps({"id": "saved-id", "message": "Successfully uploaded file"}))
        self.release.state["notary"]["app"] = {"artifact": pipeline.fingerprint(self.archive)}
        self.release.state["commands"] = [{"name": "notary-app-submit", "stdout": str(receipt)}]
        self.release.save()
        resumed = pipeline.Release(self.root, self.lock)
        with patch.object(
            resumed, "command", return_value=json.dumps({"id": "saved-id", "status": "Accepted"})
        ) as command:
            resumed.notarize("app", self.archive)
            resumed.notarize("app", self.archive)
        self.assertEqual(command.call_count, 1)
        self.assertEqual(command.call_args.args[0], "notary-app-info")

    def test_ambiguous_incomplete_upload_is_not_duplicated(self):
        self.release.state["notary"]["app"] = {"artifact": pipeline.fingerprint(self.archive)}
        with (
            patch.object(self.release, "command") as command,
            self.assertRaisesRegex(ValueError, "no complete receipt"),
        ):
            self.release.notarize("app", self.archive)
        command.assert_not_called()

    def test_changed_archive_is_rejected_before_notary_query(self):
        self.release.state["notary"]["app"] = {
            "artifact": pipeline.fingerprint(self.archive),
            "id": "saved-id",
        }
        self.archive.write_bytes(b"replacement")
        with (
            patch.object(self.release, "command") as command,
            self.assertRaisesRegex(ValueError, "changed"),
        ):
            self.release.notarize("app", self.archive)
        command.assert_not_called()

    def test_apple_rejection_gets_log_and_stops(self):
        self.release.state["notary"]["app"] = {
            "artifact": pipeline.fingerprint(self.archive),
            "id": "saved-id",
        }
        with (
            patch.object(
                self.release,
                "command",
                side_effect=[json.dumps({"id": "saved-id", "status": "Invalid"}), "synthetic log"],
            ) as command,
            self.assertRaisesRegex(ValueError, "rejected"),
        ):
            self.release.notarize("app", self.archive)
        self.assertEqual(command.call_args.args[0], "notary-app-log")

    def test_publication_cannot_overwrite_conflicting_asset(self):
        record = pipeline.fingerprint(self.archive)
        asset = {
            "name": self.archive.name,
            "state": "uploaded",
            "size": record["size"],
            "digest": "sha256:" + record["sha256"],
        }
        self.assertTrue(pipeline.matching_asset([asset], self.archive))
        self.assertFalse(pipeline.matching_asset([], self.archive))
        for changed in [{**asset, "digest": "sha256:" + "0" * 64}, {**asset, "state": "new"}]:
            with self.assertRaises(ValueError):
                pipeline.matching_asset([changed], self.archive)

    def test_native_acceptance_must_match_actual_artifact_and_every_gate(self):
        record = {
            "version": "1.12.0",
            "sha256": sdk.sha256(self.archive),
            "host": "synthetic",
            "evidence": "private evidence",
            "checks": dict.fromkeys(pipeline.REQUIRED_ACCEPTANCE, True),
        }
        pipeline.validate_acceptance(record, self.archive, "1.12.0")
        for check in pipeline.REQUIRED_ACCEPTANCE:
            with self.assertRaises(ValueError):
                pipeline.validate_acceptance(
                    {**record, "checks": {**record["checks"], check: False}}, self.archive, "1.12.0"
                )
        self.archive.write_bytes(b"not the tested artifact")
        with self.assertRaises(ValueError):
            pipeline.validate_acceptance(record, self.archive, "1.12.0")


class FeedTests(unittest.TestCase):
    def fixture(self, root):
        dmg = root / "trading-max-v1.12.0-macos-arm64.dmg"
        dmg.write_bytes(b"synthetic package")
        manifest = dmg.with_suffix(".json")
        manifest.write_text(
            json.dumps(
                {
                    "schema": 1,
                    "version": "1.12.0",
                    "target": "macos-arm64",
                    "bundle_id": feed.BUNDLE,
                    "team_id": feed.TEAM,
                    "signing": "Developer ID Application",
                    "notarized": True,
                    "minimum_macos": feed.MINIMUM_MACOS,
                    "asset": {
                        "name": dmg.name,
                        "size": dmg.stat().st_size,
                        "sha256": sdk.sha256(dmg),
                    },
                }
            )
        )
        appcast = dmg.with_suffix(".xml")
        appcast.write_bytes(
            feed.xml_bytes("1.12.0", dmg.stat().st_size, base64.b64encode(b"s" * 64).decode())
        )
        return dmg, manifest, appcast

    def test_feed_resumption_verifies_archive_and_signed_feed(self):
        with tempfile.TemporaryDirectory() as temporary:
            dmg, manifest, appcast = self.fixture(Path(temporary))
            with (
                patch.object(feed, "signing_tools", return_value=(Path("signer"), "synthetic")),
                patch.object(feed, "command") as command,
            ):
                feed.verify_existing(dmg, manifest, appcast)
            self.assertEqual(command.call_count, 2)
            self.assertTrue(all("--verify" in call.args for call in command.call_args_list))

    def test_changed_url_and_archive_are_rejected_before_signing(self):
        with tempfile.TemporaryDirectory() as temporary:
            dmg, manifest, appcast = self.fixture(Path(temporary))
            appcast.write_text(appcast.read_text().replace(feed.ORIGIN, "https://other.invalid"))
            with patch.object(feed, "signing_tools") as signing, self.assertRaises(ValueError):
                feed.verify_existing(dmg, manifest, appcast)
            signing.assert_not_called()
            dmg.write_bytes(b"changed")
            with self.assertRaises(ValueError):
                feed.validate_manifest(dmg, json.loads(manifest.read_text()), "1.12.0")

    def test_existing_feed_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            dmg, manifest, appcast = self.fixture(Path(temporary))
            before = appcast.read_bytes()
            with self.assertRaises(ValueError):
                feed.create(dmg, manifest, appcast)
            self.assertEqual(appcast.read_bytes(), before)

    def test_sdk_changed_contents_and_external_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sdk_root = root / "sdk"
            sdk_root.mkdir()
            (sdk_root / "binary").write_bytes(b"synthetic SDK")
            (sdk_root / ".verified-sdk.json").write_text(
                json.dumps(
                    {"lock": json.loads(sdk.LOCK.read_text()), "files": sdk.inventory(sdk_root)}
                )
            )
            self.assertEqual(sdk.prepare(sdk_root), sdk_root)
            (sdk_root / "binary").write_bytes(b"modified SDK")
            with self.assertRaises(ValueError):
                sdk.prepare(sdk_root)
            (sdk_root / "escape").symlink_to(root)
            with self.assertRaises(ValueError):
                sdk.inventory(sdk_root)


if __name__ == "__main__":
    unittest.main()
