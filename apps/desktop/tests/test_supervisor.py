"""Safety contracts for the native preview supervisor."""

import importlib.util
import io
import os
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "desktop_supervisor", Path(__file__).resolve().parents[1] / "scripts/supervisor.py"
)
supervisor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(supervisor)


class SupervisorTests(unittest.TestCase):
    def test_empty_workspace_is_responsive_even_before_readiness(self):
        response = io.BytesIO(b'{"service":"trading_max-api","status":"degraded"}')
        response.status = 200
        with patch.object(supervisor.urllib.request, "urlopen", return_value=response):
            self.assertTrue(supervisor.responsive("http://127.0.0.1:42000/health", api=True))

    def test_unrecognized_service_is_not_a_healthy_runtime(self):
        for body in [b"[]", b"{}", b"not-json", b'{"service":"other","status":"ok"}']:
            response = io.BytesIO(body)
            response.status = 200
            with patch.object(supervisor.urllib.request, "urlopen", return_value=response):
                self.assertFalse(supervisor.responsive("http://127.0.0.1:42000/health", api=True))

    def test_transient_stall_resets_but_persistent_stall_needs_recovery(self):
        heartbeat = supervisor.Heartbeat("api", "web")
        # A brief API stall and an independent web stall must not accumulate together.
        with patch.object(supervisor, "responsive", side_effect=[False, True, True, False]):
            heartbeat.check()
            heartbeat.check()
        with patch.object(supervisor, "responsive", return_value=True):
            heartbeat.check()
        with patch.object(supervisor, "responsive", side_effect=lambda url, **_: url == "web"):
            for _ in range(supervisor.HEARTBEAT_FAILURES - 1):
                heartbeat.check()
            with self.assertRaisesRegex(TimeoutError, "资料服务持续无响应"):
                heartbeat.check()

    def test_inherited_credentials_and_state_are_discarded(self):
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "synthetic-secret",
                "TRADING_MAX_DATA_ROOT": "/production",
                "PYTHONPATH": "/unexpected",
                "NODE_OPTIONS": "--require=/unexpected",
            },
        ):
            env = supervisor.clean_environment(Path("/preview"), 41000, 41001, "synthetic-token")
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("PYTHONPATH", env)
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertEqual(env["TRADING_MAX_DATA_ROOT"], "/preview")
        self.assertEqual(env["TRADING_MAX_ENABLE_LEGACY_CREDENTIAL_LOOKUP"], "false")
        self.assertEqual(env["TRADING_MAX_RESEARCH_ENABLED"], "false")
        self.assertEqual(env["HOSTNAME"], "127.0.0.1")

    def test_real_workspace_has_independent_credentials_and_no_demo_mode(self):
        with patch.dict(
            os.environ, {"OPENAI_API_KEY": "not-inherited", "TRADING_MAX_INTRADAY_ENABLED": "true"}
        ):
            first = supervisor.clean_environment(
                Path("/workspace"), 42000, 42001, "token", "workspace-one"
            )
            second = supervisor.clean_environment(
                Path("/other"), 42002, 42003, "token", "workspace-two"
            )
        self.assertNotEqual(
            first["TRADING_MAX_CREDENTIAL_SERVICE"], second["TRADING_MAX_CREDENTIAL_SERVICE"]
        )
        self.assertEqual(first["TRADING_MAX_ENV"], "desktop-local")
        self.assertEqual(first["TRADING_MAX_LLM_PROVIDER"], "openai")
        self.assertEqual(first["TRADING_MAX_INTRADAY_ENABLED"], "false")
        self.assertNotIn("OPENAI_API_KEY", first)

    def test_busy_port_is_preserved_and_skipped(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            port = occupied.getsockname()[1]
            self.assertNotEqual(supervisor.reserve_port(port), port)
            self.assertEqual(occupied.getsockname()[1], port)

    def test_unmarked_existing_directory_is_not_modified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "important.txt"
            original.write_text("preserve me")
            with self.assertRaisesRegex(RuntimeError, "Unmarked"):
                supervisor.prepare_state(root)
            self.assertEqual(original.read_text(), "preserve me")
            self.assertEqual(len(list(root.iterdir())), 1)

    def test_preview_state_is_seeded_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "Preview with spaces"
            runtime = Path(directory) / "runtime"
            (runtime / "seed").mkdir(parents=True)
            (runtime / "seed/value.json").write_text('{"synthetic":true}')
            with patch.object(supervisor, "RUNTIME", runtime):
                supervisor.prepare_state(root)
                (root / "value.json").write_text('{"preserved":true}')
                supervisor.prepare_state(root)
            self.assertEqual((root / "value.json").read_text(), '{"preserved":true}')

    def test_wrong_identity_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "DESKTOP_PREVIEW_ONLY").write_text("not this app")
            with self.assertRaisesRegex(RuntimeError, "identity"):
                supervisor.prepare_state(root)


if __name__ == "__main__":
    unittest.main()
