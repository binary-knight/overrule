#!/usr/bin/env python3
"""Restart this Model Mesh checkout on Linux, without killing unrelated listeners."""

import fcntl
import http.client
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parent.parent


def fail(message):
    raise RuntimeError(message)


def listeners(port):
    result = subprocess.run(
        ["lsof", "-nP", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"],
        capture_output=True, text=True,
    )
    if result.returncode not in (0, 1) or (result.returncode == 1 and result.stderr.strip()):
        fail("Could not inspect the listening port: " + result.stderr.strip())
    return {int(value) for value in result.stdout.split()}


def identity(pid):
    """Recognize the exact Node entry point and remember its process birth time."""
    try:
        proc = Path(f"/proc/{pid}")
        args = (proc / "cmdline").read_bytes().split(b"\0")
        if len(args) < 2 or Path(os.fsdecode(args[0])).name not in ("node", "nodejs"):
            return None
        cwd = (proc / "cwd").resolve(strict=True)
        entry = Path(os.fsdecode(args[1]))
        if (cwd / entry).resolve() != ROOT / "server.mjs":
            return None
        # Field 22 is the start time; splitting after ')' handles spaces in comm.
        start_time = (proc / "stat").read_text().rsplit(")", 1)[1].split()[19]
        return start_time
    except (OSError, IndexError, ValueError):
        return None


def wait_for_exit(pid, birth, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if identity(pid) != birth:
            return True
        time.sleep(0.15)
    return False


def health(host, port):
    connection = http.client.HTTPConnection(host, port, timeout=1)
    try:
        connection.request("GET", "/")
        response = connection.getresponse()
        response.read()
        return response.status == 200
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def main():
    if len(sys.argv) > 1:
        if sys.argv[1:] not in (["--help"], ["-h"]):
            fail("Unexpected arguments. Use --help for usage.")
        print("Usage: /home/jknight/model-mesh/restart.sh\n"
              "Or:    cd /home/jknight/model-mesh && npm restart\n\n"
              "Stops only this checkout's server, then starts it in the background.\n"
              "Settings: PORT (default 4310), MESH_HOST, MESH_DATA_DIR, NODE_BIN.\n"
              "Logs and PID are saved in the data directory. Requires Linux, Python 3, Node 22+, and lsof.")
        return
    if sys.platform != "linux":
        fail("This restart script uses Linux /proc process checks.")
    for command in ("lsof",):
        if not shutil.which(command):
            fail(f"Install {command} before using this script.")
    node = os.environ.get("NODE_BIN") or shutil.which("node")
    if not node:
        fail("Node.js is not on PATH. Open your usual terminal, or set NODE_BIN to its full path.")
    try:
        version = subprocess.check_output([node, "--version"], text=True).strip()
        if int(version.lstrip("v").split(".")[0]) < 22:
            fail("Model Mesh needs Node.js 22 or newer.")
        port = int(os.environ.get("PORT", "4310"))
        if not 1 <= port <= 65535:
            raise ValueError()
    except ValueError:
        fail("PORT must be an integer between 1 and 65535.")
    # Check syntax before disturbing the current server.
    subprocess.run([node, "--check", str(ROOT / "server.mjs")], check=True)
    directory = Path(os.environ.get("MESH_DATA_DIR") or ROOT / "data")
    if not directory.is_absolute():
        directory = ROOT / directory
    directory = directory.resolve()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    log_path = directory / "server.log"
    pid_path = directory / "server.pid"
    # One restart at a time for this checkout, even with different data directories.
    lock_directory = ROOT / "data"
    lock_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with os.fdopen(os.open(lock_directory / "restart.lock", os.O_CREAT | os.O_RDWR, 0o600), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("A restart is already in progress. Wait for it to finish.")
        current = listeners(port)
        known = {pid: identity(pid) for pid in current}
        if any(birth is None for birth in known.values()):
            fail(f"Port {port} belongs to a different process. Nothing was stopped.")
        for pid, birth in known.items():
            print(f"Stopping Model Mesh (PID {pid})…", flush=True)
            if identity(pid) == birth:
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            if not wait_for_exit(pid, birth):
                fail(f"PID {pid} is still shutting down after 20 seconds. No replacement was started; retry once it exits.")
        if listeners(port):
            fail(f"Port {port} is still in use. No replacement was started.")
        with os.fdopen(os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), "ab", buffering=0) as log:
            log.write(f"\n--- Started {time.strftime('%Y-%m-%d %H:%M:%S %Z')} ---\n".encode())
            env = {**os.environ, "PORT": str(port), "MESH_DATA_DIR": str(directory)}
            # Ensure the chosen Node installation's sibling CLIs remain on PATH.
            node_path = shutil.which(node) or node
            env["PATH"] = str(Path(node_path).absolute().parent) + os.pathsep + env.get("PATH", "")
            child = subprocess.Popen(
                [node, str(ROOT / "server.mjs")], cwd=ROOT, env=env,
                stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                start_new_session=True, close_fds=True,
            )
        with os.fdopen(os.open(pid_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as file:
            file.write(str(child.pid) + "\n")
        host = env.get("MESH_HOST") or "0.0.0.0"
        probe_host = "127.0.0.1" if host == "0.0.0.0" else host
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if child.poll() is not None:
                pid_path.unlink(missing_ok=True)
                fail(f"The server exited with code {child.returncode}. See {log_path}")
            if child.pid in listeners(port) and health(probe_host, port):
                print(f"Model Mesh is running in the background (PID {child.pid}).")
                print(f"Open: http://{probe_host}:{port}")
                print(f"Log:  {log_path}")
                print("LAN devices must pair again; get the current code from LAN access or data/lan.json.")
                return
            time.sleep(0.25)
        fail(f"The server started (PID {child.pid}) but did not pass its health check. See {log_path}")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"Restart failed: {error}", file=sys.stderr)
        sys.exit(1)
