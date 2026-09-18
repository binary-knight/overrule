"""Exercise the restart helper against disposable servers, never real providers."""
import fcntl
import http.client
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent.parent


class RestartTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mesh restart test ")
        self.app = Path(self.temporary.name)
        (self.app / "scripts").mkdir()
        shutil.copy(ROOT / "restart.sh", self.app)
        shutil.copy(ROOT / "scripts/restart.py", self.app / "scripts")
        (self.app / "server.mjs").write_text(
            "import http from 'node:http';\n"
            "const server = http.createServer((req, res) => res.end('fixture'));\n"
            "server.listen(Number(process.env.PORT), '127.0.0.1');\n"
            "process.on('SIGTERM', () => server.close());\n"
        )
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.env = {**os.environ, "PORT": str(self.port), "MESH_HOST": "127.0.0.1", "MESH_DATA_DIR": str(self.app / "data")}
        self.children = []

    def tearDown(self):
        for child in self.children:
            child.terminate()
            child.wait(timeout=5)
        pid_file = self.app / "data/server.pid"
        if pid_file.exists():
            try:
                os.kill(int(pid_file.read_text()), signal.SIGTERM)
            except ProcessLookupError:
                pass
        self.temporary.cleanup()

    def restart(self):
        return subprocess.run(["bash", str(self.app / "restart.sh")], cwd="/tmp", env=self.env,
                              capture_output=True, text=True, timeout=40)

    def responding(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=1)
        try:
            connection.request("GET", "/")
            return connection.getresponse().status == 200
        except OSError:
            return False
        finally:
            connection.close()

    def test_start_then_restart_from_another_directory(self):
        first = self.restart()
        self.assertEqual(first.returncode, 0, first.stderr)
        old_pid = (self.app / "data/server.pid").read_text()
        self.assertTrue(self.responding())
        second = self.restart()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertNotEqual(old_pid, (self.app / "data/server.pid").read_text())
        self.assertTrue(self.responding())
        self.assertIn("Stopping Model Mesh", second.stdout)

    def test_unrelated_listener_is_left_running(self):
        child = subprocess.Popen([sys.executable, "-m", "http.server", str(self.port), "--bind", "127.0.0.1"],
                                 cwd=self.app, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.children.append(child)
        for _ in range(50):
            if self.responding():
                break
            time.sleep(0.1)
        self.assertTrue(self.responding())
        result = self.restart()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("different process", result.stderr)
        self.assertIsNone(child.poll())
        self.assertTrue(self.responding())

    def test_concurrent_restart_is_refused(self):
        (self.app / "data").mkdir()
        with (self.app / "data/restart.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.restart()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("already in progress", result.stderr)

    def test_bad_syntax_does_not_stop_healthy_server(self):
        self.assertEqual(self.restart().returncode, 0)
        (self.app / "server.mjs").write_text("invalid javascript !!!")
        result = self.restart()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.responding())


if __name__ == "__main__":
    unittest.main(verbosity=2)
