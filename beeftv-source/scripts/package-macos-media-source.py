#!/usr/bin/env python3
"""Archive the exact source and recipe used by package-media-runtime-macos.sh."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile


def package(source, runtime, target, output):
    source, runtime, output = Path(source), Path(runtime), Path(output)
    facts = json.loads((runtime / "manifest.json").read_text())
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != facts["sourceSHA256"] or facts["target"] != target:
        raise ValueError("Source does not match the compiled ffprobe manifest")
    if hashlib.sha256((runtime / "ffprobe").read_bytes()).hexdigest() != facts["probeSHA256"]:
        raise ValueError("ffprobe does not match its build manifest")
    platform = target.replace("/", "-")
    recipe = Path(__file__).with_name("package-media-runtime-macos.sh").read_bytes()
    files = {
        "ffmpeg-source.tar.gz": source.read_bytes(),
        "package-media-runtime-macos.sh": recipe,
        "LICENSE": (runtime / "LICENSE").read_bytes(),
        "build-record.txt": (runtime / "README.txt").read_bytes(),
        "BUILD.txt": (f"Build on macOS with Xcode Command Line Tools, bash and make.\n"
                      f"bash package-media-runtime-macos.sh {target} ./media-runtime ./ffmpeg-source.tar.gz\n"
                      "The recorded build flags are in build-record.txt. No third-party libraries are enabled.\n"
                      "The source archive is unmodified. The recipe chooses the installed Apple SDK.\n").encode(),
    }
    manifest = {
        "schema": 1, "id": f"ffprobe-{platform}", "version": "8.0.1",
        "license": "LGPL-2.1-or-later", "binaryHashes": {"ffprobe": facts["probeSHA256"]},
        "provenance": {"status": "built", "sourceCommit": facts["sourceCommit"], "target": target},
        "sources": [{"path": name, "sha256": hashlib.sha256(files[name]).hexdigest()}
                    for name in ["ffmpeg-source.tar.gz", "package-media-runtime-macos.sh"]],
        "buildInstructions": "BUILD.txt", "licenses": ["LICENSE"],
    }
    files["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    # A local rebuild may replace its own packet. Published objects are protected
    # by the publisher's immutable storage contract, not by a local stale file.
    with tempfile.TemporaryDirectory(prefix=".media-source-", dir=output.parent) as scratch:
        temporary = Path(scratch) / "source.tar.gz"
        with temporary.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for name, data in sorted(files.items()):
                    entry = tarfile.TarInfo(name)
                    entry.size, entry.mode, entry.mtime = len(data), 0o644, 0
                    archive.addfile(entry, io.BytesIO(data))
        temporary.replace(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "runtime", "target", "output"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    package(args.source, args.runtime, args.target, args.output)
