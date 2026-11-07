"""Small real-process controls for the live native HTTP command owner."""
from pathlib import Path
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import native_http_tests

ROOT = Path(__file__).resolve().parents[2]


class NativeHttpCommandOwnership(unittest.TestCase):
    sequence = 0

    def run_command(self, *args):
        type(self).sequence += 1
        try:
            return native_http_tests.run_command(*args)
        finally:
            destination = os.environ.get("NATIVE_HTTP_CONTROL_OUTPUT")
            diagnostic = args[4] if len(args) > 4 else None
            if destination and diagnostic is not None and diagnostic.is_dir():
                target = Path(destination) / f"command-{self.sequence}"
                target.mkdir(parents=True, exist_ok=False)
                for path in diagnostic.iterdir():
                    if path.is_file():
                        shutil.copyfile(path, target / path.name)

    def test_normal_command_progress_actual_wait_and_absence(self):
        with tempfile.TemporaryDirectory(prefix="native-http-control-") as directory:
            evidence = Path(directory) / "evidence"
            code = self.run_command([sys.executable, "-c", "pass"], ROOT,
                                    {"PATH": os.defpath}, 3, evidence)
            self.assertEqual(code, 0)
            result = json.loads((evidence / "result.json").read_text())
            monitor = json.loads((evidence / "monitor-parent.json").read_text())
            self.assertTrue(result["cleanup"]["actual_parent_wait"])
            self.assertTrue(result["cleanup"]["cleanup_confirmed_absent"])
            self.assertTrue(monitor["cleanup"]["actual_parent_wait"])
            self.assertTrue(monitor["cleanup"]["cleanup_confirmed_absent"])
            self.assertTrue((evidence / "progress.jsonl").is_file())

    def test_timeout_reaps_exact_grandchild_and_retains_primary(self):
        with tempfile.TemporaryDirectory(prefix="native-http-control-") as directory:
            evidence = Path(directory) / "evidence"
            pidfile = Path(directory) / "leaf.pid"
            script = ("import subprocess,time; c=subprocess.Popen(['/bin/sleep','30']);"
                      f"open({str(pidfile)!r},'w').write(str(c.pid));time.sleep(30)")
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_command([sys.executable, "-c", script], ROOT,
                                 {"PATH": os.defpath}, .5, evidence)
            result = json.loads((evidence / "result.json").read_text())
            self.assertEqual(result["primary_error"], "TimeoutExpired")
            self.assertTrue(result["cleanup"]["actual_parent_wait"])
            self.assertTrue(result["cleanup"]["cleanup_confirmed_absent"])
            leaf = int(pidfile.read_text())
            if sys.platform == "linux":
                self.assertTrue(any(row["pid"] == leaf and row["waited_pid"] == leaf
                                    for row in result["cleanup"]["actual_adopted_child_waits"]))
            with self.assertRaises(ProcessLookupError):
                os.kill(leaf, 0)

    def test_nonzero_exit_remains_nonzero(self):
        self.assertEqual(self.run_command([sys.executable, "-c", "raise SystemExit(7)"],
                                          ROOT, {"PATH": os.defpath}, 3), 7)

    def test_cancellation_keeps_primary_and_waits_command(self):
        with tempfile.TemporaryDirectory(prefix="native-http-control-") as directory:
            ready = Path(directory) / "ready"
            evidence = Path(directory) / "evidence"

            def signal_after_child_ready():
                deadline = time.monotonic() + 2
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                if ready.exists():
                    os.kill(os.getpid(), signal.SIGTERM)

            sender = threading.Thread(target=signal_after_child_ready)
            sender.start()
            script = f"import pathlib,time;pathlib.Path({str(ready)!r}).write_text('ready');time.sleep(30)"
            try:
                with self.assertRaises(native_http_tests.CommandInterrupted):
                    self.run_command([sys.executable, "-c", script], ROOT,
                                     {"PATH": os.defpath}, 3, evidence)
            finally:
                sender.join(timeout=3)
            self.assertFalse(sender.is_alive())
            result = json.loads((evidence / "result.json").read_text())
            monitor = json.loads((evidence / "monitor-parent.json").read_text())
            self.assertEqual(result["primary_error"], "CommandInterrupted")
            self.assertTrue(result["cleanup"]["actual_parent_wait"])
            self.assertTrue(result["cleanup"]["cleanup_confirmed_absent"])
            self.assertTrue(monitor["cleanup"]["actual_parent_wait"])

    def test_monitor_nonzero_rejects_prewritten_success(self):
        with tempfile.TemporaryDirectory(prefix="native-http-control-") as directory:
            fake = Path(directory) / "monitor.py"
            fake.write_text("import sys,json,pathlib;p=pathlib.Path(sys.argv[sys.argv.index('--diagnostic-dir')+1]);"
                            "(p/'result.json').write_text(json.dumps({'primary_error':None,'exit_code':0,"
                            "'cleanup':{'actual_parent_wait':True,'cleanup_confirmed_absent':True,'clean':True}}));"
                            "raise SystemExit(7)")
            original = native_http_tests.__file__
            native_http_tests.__file__ = str(fake)
            try:
                with self.assertRaisesRegex(RuntimeError, "monitor wait status differs"):
                    self.run_command([sys.executable, "-c", "pass"], ROOT, {"PATH": os.defpath}, 3)
            finally:
                native_http_tests.__file__ = original

    def test_existing_fixture_child_survives_command_cleanup(self):
        fixture = subprocess.Popen(["/bin/sleep", "30"])
        try:
            self.assertEqual(self.run_command([sys.executable, "-c", "pass"],
                                              ROOT, {"PATH": os.defpath}, 3), 0)
            self.assertIsNone(fixture.poll())
        finally:
            fixture.terminate()
            fixture.wait(timeout=2)


if __name__ == "__main__":
    unittest.main()
