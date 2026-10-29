#!/usr/bin/env python3
"""Exercise the CLI from the release ZIP against an isolated authenticated catalog."""
import argparse
import http.server
import json
import os
from pathlib import Path
import queue
import secrets
import stat
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
import zipfile


def smoke(archive, platform):
    relative = ("cli/beeftv.exe" if platform == "windows-amd64" else
                "BeefTV-linux/cli/beeftv" if platform == "linux-amd64" else
                "BeefTV.app/Contents/MacOS/cli/beeftv")
    with tempfile.TemporaryDirectory(prefix="beeftv-package-smoke-") as directory:
        root = Path(directory)
        cli = root / relative
        # Extract only the shipped executable; never start the desktop or open user data.
        with zipfile.ZipFile(archive) as bundle:
            entries = [item for item in bundle.infolist() if item.filename == relative]
            if len(entries) != 1 or not entries[0].file_size:
                raise RuntimeError("release ZIP must contain one nonempty " + relative)
            entry = entries[0]
            mode = entry.external_attr >> 16
            if not stat.S_ISREG(mode):
                raise RuntimeError("shipped CLI is not a regular file")
            if platform != "windows-amd64" and not mode & 0o111:
                raise RuntimeError("shipped CLI lost executable mode")
            cli.parent.mkdir(parents=True)
            cli.write_bytes(bundle.read(entry))
            cli.chmod(mode & 0o777)

        token = secrets.token_hex(24)
        requests = []

        class Backend(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                authorized = (self.path in ("/api/ops", "/api/business/tools") and
                              self.headers.get("X-Beeftv-Client") == "release-smoke" and
                              self.headers.get("Authorization") == "Bearer " + token and
                              not self.headers.get("X-Beeftv-Owner") and
                              not self.headers.get("X-Desktop-Token"))
                requests.append((self.path, authorized))
                self.send_response(200 if authorized else 403)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                data = {
                    "ops": [{"id": "release.smoke", "summary": "Isolated release smoke",
                             "readOnly": True, "params": {"type": "object"}}]
                } if self.path == "/api/ops" else {
                    "tools": [{"id": "release.business.smoke", "summary": "Isolated business catalog",
                               "readOnly": True, "method": "GET", "path": "/release-smoke",
                               "params": {"type": "object", "properties": {}}}]
                }
                self.wfile.write(json.dumps({"code": 0 if authorized else 403,
                                             "data": data if authorized else {}}).encode())

            def log_message(self, *_args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("BEEFTV_") and not key.startswith("CANVAS_")}
        env.update(BEEFTV_BASE_URL=f"http://127.0.0.1:{server.server_port}/api",
                   BEEFTV_DATA_DIR=str(root / "data"), BEEFTV_CLIENT_ID="release-smoke",
                   BEEFTV_CLIENT_TOKEN=token)
        process = None
        try:
            with (root / "stderr.log").open("w+") as stderr:
                process = subprocess.Popen([str(cli), "mcp", "serve", "--read-only"],
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=stderr, text=True, encoding="utf-8", env=env,
                                           cwd=root)
                messages = queue.Queue()

                def read_stdout():
                    for line in process.stdout:
                        messages.put(line)
                    messages.put(None)

                threading.Thread(target=read_stdout, daemon=True).start()

                def send(value):
                    process.stdin.write(json.dumps({"jsonrpc": "2.0", **value}) + "\n")
                    process.stdin.flush()

                def receive(request_id):
                    line = messages.get(timeout=20)
                    if line is None:
                        stderr.flush()
                        stderr.seek(0)
                        detail = stderr.read(4096).replace(token, "[redacted]").strip()
                        raise RuntimeError("packaged CLI exited before MCP response: " + detail)
                    message = json.loads(line)
                    if message.get("id") != request_id or "error" in message:
                        raise RuntimeError("unexpected MCP response: " + line)
                    return message["result"]

                send({"id": 1, "method": "initialize", "params": {
                    "protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "release-smoke", "version": "1.0"}}})
                initialized = receive(1)
                if initialized.get("serverInfo", {}).get("name") != "beeftv":
                    raise RuntimeError("initialize did not identify beeftv")
                send({"method": "notifications/initialized"})
                send({"id": 2, "method": "tools/list", "params": {}})
                tools = receive(2).get("tools", [])
                if sorted(tool.get("name") for tool in tools) != ["release.business.smoke", "release.smoke"]:
                    raise RuntimeError("tools/list did not return the authenticated mock catalog")
                if ({route for route, _ in requests} != {"/api/ops", "/api/business/tools"}
                        or not all(authorized for _, authorized in requests)):
                    raise RuntimeError("catalog request did not use isolated client credentials")
                headers = {"X-Beeftv-Client": "release-smoke", "Authorization": "Bearer " + token}
                for route in ("/api/ops", "/api/business/tools"):
                    for invalid in ({}, {**headers, "Authorization": "Bearer invalid"},
                                    {**headers, "X-Beeftv-Owner": "owner"},
                                    {**headers, "X-Desktop-Token": "desktop"}):
                        request = urllib.request.Request(env["BEEFTV_BASE_URL"][:-4] + route,
                                                         headers=invalid)
                        try:
                            urllib.request.urlopen(request, timeout=5).close()
                        except urllib.error.HTTPError as error:
                            if error.code != 403:
                                raise RuntimeError("unexpected credential rejection") from error
                        else:
                            raise RuntimeError("mock catalog accepted invalid credentials")
                request = urllib.request.Request(env["BEEFTV_BASE_URL"] + "/unknown", headers=headers)
                try:
                    urllib.request.urlopen(request, timeout=5).close()
                except urllib.error.HTTPError as error:
                    if error.code != 403:
                        raise RuntimeError("unexpected route rejection") from error
                else:
                    raise RuntimeError("mock catalog accepted unknown route")
                process.stdin.close()
                if process.wait(timeout=10) != 0:
                    raise RuntimeError("packaged CLI exited unsuccessfully")
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=10)
            if process is not None:
                process.stdin.close()
                process.stdout.close()
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)
        print(f"PASS {platform}: extracted shipped CLI initialize + tools/list; authenticated mock only")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--platform", choices=["darwin-arm64", "darwin-amd64", "windows-amd64", "linux-amd64"], required=True)
    args = parser.parse_args()
    smoke(args.archive, args.platform)
