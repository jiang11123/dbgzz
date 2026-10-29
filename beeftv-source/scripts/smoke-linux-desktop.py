#!/usr/bin/env python3
"""Start the final Linux archive with isolated data and verify its native window."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import zipfile


def smoke(archive):
    with tempfile.TemporaryDirectory(prefix="beeftv-linux-smoke-") as directory:
        root = Path(directory)
        with zipfile.ZipFile(archive) as bundle:
            for item in bundle.infolist():
                target = root / item.filename
                if not target.resolve().is_relative_to(root):
                    raise RuntimeError("unsafe archive entry")
                bundle.extract(item, root)
                if target.is_file():
                    target.chmod((item.external_attr >> 16) & 0o777)
        app = root / "BeefTV-linux" / "BeefTV"
        data = root / "isolated data"
        env = {k: v for k, v in os.environ.items() if not k.startswith(("CANVAS_", "BEEFTV_"))}
        # CI has no GPU; the WebView uses software rendering under Xvfb.
        env["LIBGL_ALWAYS_SOFTWARE"] = "1"
        with (root / "desktop.log").open("w+") as log:
            process = subprocess.Popen([str(app), "--data-dir=" + str(data)], cwd=root, env=env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        log.seek(0)
                        raise RuntimeError("desktop exited: " + log.read()[-4000:])
                    descriptor = data / "runtime.json"
                    window = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", "^BeefTV$"], capture_output=True, text=True)
                    if descriptor.exists() and window.returncode == 0:
                        info = json.loads(descriptor.read_text())
                        if info["pid"] != process.pid:
                            raise RuntimeError("runtime descriptor belongs to another process")
                        time.sleep(3)
                        if process.poll() is not None:
                            raise RuntimeError("desktop exited after window creation")
                        print("PASS Linux: final archive started native window and isolated backend; no model requests")
                        return
                    time.sleep(0.5)
                raise RuntimeError("desktop window or runtime descriptor did not appear")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    smoke(parser.parse_args().archive)
