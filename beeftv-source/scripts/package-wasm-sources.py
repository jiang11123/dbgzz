#!/usr/bin/env python3
"""Collect pinned ffmpeg.wasm sources; never build or change the product runtime."""

import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import tempfile
import urllib.request


DEFAULT_LOCK = Path(__file__).resolve().parents[1] / "licenses/ffmpeg-wasm-sources.json"
BUILD_INSTRUCTIONS = """# ffmpeg.wasm 0.12.10 source and build instructions

This bundle preserves GPL-enabled x264/x265 and the existing media features.
The source release, dependency revisions and published core hashes are recorded
in source-lock.json. This is the upstream release's source and build recipe,
not a claim of byte-for-byte reproducibility or a publisher-signed attestation.

All application/library source archives and the zimg googletest submodule are
included with pinned commits and SHA-256. The release snapshot includes the
modified src/fftools, src/bind, Dockerfile, Makefile and every build/*.sh.
Emscripten 3.1.40 sources and its SDL 2.24.2 port are included. Toolchain binaries
and the operating system packages are prerequisites, not included source inputs.
The bundled root MIT license belongs to ffmpeg.wasm wrapper/build code; the
shipped core remains GPL-2.0-or-later. Worker execution is not a license exemption.

Requires Python 3.12+ and Docker with a linux/amd64 builder. From this directory:

    python3 rebuild.py --prepare-build ./build-context --bundle-dir .
    cd build-context
    bash prepare-toolchain.sh
    bash build-offline.sh

prepare-toolchain.sh is an explicitly ONLINE preparation step: it pulls the
digest-pinned Emscripten image and installs the build tools required by the
upstream Dockerfile. It records the resulting local image ID. Preserve that
image using docker save/load before taking the machine offline. apt package
versions are recorded in toolchain-packages.txt; this is a new candidate build
environment, not the historical publisher environment. No image is published.

build-offline.sh verifies that local image ID, gives it a content-specific local
tag, and uses the default Docker driver with --pull=false and --network=none.
The Dockerfile has no remote ADD, git clone, apt operation or external frontend;
all libraries, the gitlink and SDL port come from this bundle. It invokes the
upstream build scripts and production single-thread flags -O3 -msimd128. Outputs
are dist/esm and dist/umd. BuildKit must already be installed/available locally.

The collector does not execute either build. Archive verification and successful
context preparation do not prove compilation succeeds. Rebuilding is optional
for source retrieval. If adopting rebuilt binaries, record the environment, logs,
output hashes and media behavior tests separately; do not label new binaries with
the published npm binary hashes.

The bundled Makefile/Dockerfile retain the original upstream recipe for review.
The generated Dockerfile.offline only substitutes local sources, the prepared
toolchain and the local SDL port; source code and codec flags remain unchanged.
Some upstream scripts have known workarounds: HarfBuzz rewrites its pthread
configure probe; Vorbis removes -mno-ieee-fp; FreeType builds apinames with native
gcc; FriBidi tolerates make failure then copies pkgconfig; x265 combines 8/10/12
bit libraries. These are preserved and any build failures must be investigated.
"""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def safe_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or not value or ".." in path.parts or "\\" in value:
        raise ValueError(f"Unsafe bundle path: {value}")
    return path


def load_lock(path):
    lock = json.loads(path.read_text())
    ids = [source["id"] for source in lock["sources"]]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("Source lock must contain unique sources")
    for source in lock["sources"]:
        if not re.fullmatch(r"[0-9a-f]{40}", source["revision"]):
            raise ValueError("Every source requires an immutable Git commit")
        if not re.fullmatch(r"[0-9a-f]{64}", source["sha256"]):
            raise ValueError("Every source requires a SHA-256")
        safe_path(source["filename"])
        expected = f"https://codeload.github.com/{source['repository']}/tar.gz/{source['revision']}"
        if source["url"] != expected:
            raise ValueError("Source URL must address the locked Git commit")
    return lock


def source_bytes(source, cache, offline):
    target = cache / source["filename"]
    if target.exists():
        data = target.read_bytes()
    elif offline:
        raise ValueError(f"Missing offline source: {target.name}")
    else:
        with urllib.request.urlopen(source["url"], timeout=120) as response:
            data = response.read()
    if digest(data) != source["sha256"]:
        raise ValueError(f"Source checksum mismatch: {target.name}")
    if not target.exists():
        target.write_bytes(data)
    return data


def license_files(source, data):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        members = archive.getmembers()
        roots = {PurePosixPath(member.name).parts[0] for member in members}
        if len(roots) != 1:
            raise ValueError(f"Source archive must have one root: {source['id']}")
        root = roots.pop()
        for path in source["licensePaths"]:
            safe_path(path)
            member = archive.getmember(f"{root}/{path}")
            if not member.isfile():
                raise ValueError(f"Missing regular license file: {path}")
            yield f"licenses/{source['id']}/{path}", archive.extractfile(member).read()


def verify_contents(read, lock):
    manifest = json.loads(read("manifest.json"))
    for field in ("id", "version", "license", "binaryHashes", "provenance"):
        if manifest.get(field) != lock[field]:
            raise ValueError(f"Manifest differs from source lock: {field}")
    expected = {f"sources/{s['filename']}": s["sha256"] for s in lock["sources"]}
    actual = {s["path"]: s["sha256"] for s in manifest["sources"]}
    if actual != expected or len(manifest["sources"]) != len(expected):
        raise ValueError("Manifest source inventory differs from lock")
    expected_licenses = {f"licenses/{s['id']}/{p}" for s in lock["sources"] for p in s["licensePaths"]}
    if set(manifest["licenses"]) != expected_licenses:
        raise ValueError("Manifest license inventory differs from lock")
    required = expected_licenses | {"BUILD.md", "rebuild.py", "source-lock.json"}
    if set(manifest["fileHashes"]) != required or manifest["buildInstructions"] != "BUILD.md":
        raise ValueError("Manifest build instructions or license files are incomplete")
    for path, sha in {**expected, **manifest["fileHashes"]}.items():
        safe_path(path)
        if digest(read(path)) != sha:
            raise ValueError(f"Bundle checksum mismatch: {path}")
    if json.loads(read("source-lock.json")) != lock:
        raise ValueError("Bundled source lock differs from trusted lock")
    return manifest


def verify_archive(path, lock):
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        names = [m.name for m in members]
        if len(names) != len(set(names)) or any(not m.isfile() for m in members):
            raise ValueError("Bundle must contain unique regular files")
        for name in names:
            safe_path(name)
        def read(name):
            return archive.extractfile(archive.getmember(name)).read()
        return verify_contents(read, lock)


def verify_binary(directory, lock):
    for kind, filename in (("wasm", "ffmpeg-core.wasm"), ("javascript", "ffmpeg-core.js")):
        if digest((directory / filename).read_bytes()) != lock["binaryHashes"][kind]:
            raise ValueError(f"Published core checksum mismatch: {filename}")


def collect(lock, version, output, cache, offline=False):
    if not re.fullmatch(r"v?\d+\.\d+\.\d+(?:[.-][A-Za-z0-9_.-]+)?", version):
        raise ValueError("Invalid BeefTV release version")
    version = "v" + version.removeprefix("v")
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    destination = output / f"BeefTV-{version}-ffmpeg-wasm-sources.tar.gz"
    if destination.exists():
        raise ValueError(f"Refusing to overwrite: {destination}")
    with tempfile.TemporaryDirectory(prefix=".wasm-sources-", dir=output) as temp:
        staging = Path(temp)
        sources, licenses = [], []
        def put(path, data):
            target = staging / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        for source in lock["sources"]:
            data = source_bytes(source, cache, offline)
            path = f"sources/{source['filename']}"
            put(path, data)
            sources.append({"id": source["id"], "path": path, "sha256": source["sha256"], "revision": source["revision"]})
            for path, data in license_files(source, data):
                put(path, data)
                licenses.append(path)
        put("BUILD.md", BUILD_INSTRUCTIONS.encode())
        put("rebuild.py", Path(__file__).read_bytes())
        put("source-lock.json", json_bytes(lock))
        manifest = {k: lock[k] for k in ("id", "version", "license", "binaryHashes", "provenance")}
        manifest.update(schemaVersion=1, beefTVVersion=version, sources=sources, licenses=licenses,
                        buildInstructions="BUILD.md", buildRecipe="rebuild.py",
                        fileHashes={p: digest((staging / p).read_bytes()) for p in licenses + ["BUILD.md", "rebuild.py", "source-lock.json"]})
        put("manifest.json", json_bytes(manifest))
        verify_contents(lambda p: (staging / p).read_bytes(), lock)
        temporary = staging / "bundle.tar.gz"
        with temporary.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for path in sorted(staging.rglob("*")):
                    if path.is_file() and path != temporary:
                        info = archive.gettarinfo(str(path), str(path.relative_to(staging)))
                        info.uid = info.gid = info.mtime = 0
                        info.uname = info.gname = ""
                        info.mode = 0o644
                        with path.open("rb") as stream:
                            archive.addfile(info, stream)
        verify_archive(temporary, lock)
        temporary.rename(destination)
    return destination


def prepare_build(bundle, destination, lock):
    verify_contents(lambda p: (bundle / p).read_bytes(), lock)
    if destination.exists():
        raise ValueError(f"Refusing to overwrite build context: {destination}")
    destination.mkdir(parents=True)
    for source in lock["sources"]:
        with tarfile.open(bundle / "sources" / source["filename"], "r:gz") as archive:
            with tempfile.TemporaryDirectory(dir=destination) as temp:
                archive.extractall(temp, filter="data")
                roots = list(Path(temp).iterdir())
                if len(roots) != 1 or not roots[0].is_dir():
                    raise ValueError("Expected a single source archive directory")
                target = destination / "sources" / source["id"]
                target.parent.mkdir(exist_ok=True)
                roots[0].rename(target)
    for submodule in lock["submodules"]:
        target = destination / "sources" / submodule["parentId"] / safe_path(submodule["path"])
        shutil.copytree(destination / "sources" / submodule["sourceId"], target, dirs_exist_ok=True)
    upstream = destination / "sources/ffmpeg-wasm"
    for name in ("build", "src"):
        shutil.copytree(upstream / name, destination / name)
    dockerfile = (upstream / "Dockerfile").read_text()
    dockerfile = re.sub(r"^# syntax=.*\n", "", dockerfile)
    dockerfile = dockerfile.replace("FROM emscripten/emsdk:3.1.40 AS emsdk-base", "ARG TOOLCHAIN_IMAGE\nFROM ${TOOLCHAIN_IMAGE} AS emsdk-base")
    dockerfile = re.sub(r"RUN apt-get update && \\\n\s+apt-get install -y pkg-config autoconf automake libtool ragel", "RUN command -v pkg-config && command -v autoconf && command -v automake && command -v libtoolize && command -v ragel", dockerfile)
    dockerfile = dockerfile.replace("RUN apt-get update && apt-get install -y git\n", "")
    for source in lock["sources"]:
        pattern = rf"ADD https://github\.com/{re.escape(source['repository'])}\.git#[^\s]+ /src"
        dockerfile = re.sub(pattern, f"COPY sources/{source['id']}/ /src/", dockerfile)
    dockerfile = dockerfile.replace("RUN git clone --recursive -b $ZIMG_BRANCH https://github.com/sekrit-twc/zimg.git /src", "COPY sources/zimg/ /src/")
    dockerfile = dockerfile.replace("RUN embuilder build sdl2 sdl2-mt", "COPY sources/sdl2/ /local-ports/sdl2/\nENV EMCC_LOCAL_PORTS=sdl2=/local-ports/sdl2\nRUN embuilder build sdl2 sdl2-mt")
    if re.search(r"^ADD https?://|git clone|apt-get|^# syntax=", dockerfile, re.M):
        raise ValueError("Upstream Dockerfile contains an unhandled online dependency")
    (destination / "Dockerfile.offline").write_text(dockerfile)
    (destination / "Dockerfile.toolchain").write_text(
        f"FROM {lock['toolchain']['image']}\n"
        "RUN apt-get update && apt-get install -y pkg-config autoconf automake libtool ragel git && rm -rf /var/lib/apt/lists/*\n")
    (destination / "prepare-toolchain.sh").write_text("""#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
docker build --platform linux/amd64 --iidfile toolchain-image.id -f Dockerfile.toolchain .
image=$(cat toolchain-image.id)
docker run --rm --platform linux/amd64 --network none "$image" dpkg-query -W > toolchain-packages.txt
docker run --rm --platform linux/amd64 --network none "$image" emcc --version > toolchain-version.txt
echo "Prepared local image: $image"
""")
    (destination / "build-offline.sh").write_text("""#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
image=$(cat toolchain-image.id)
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Invalid prepared image ID" >&2; exit 1; }
builder=$(docker context show)
[[ "$(docker buildx inspect "$builder" | awk '$1 == "Driver:" {print $2}')" == docker ]] || { echo "Use the current context's local Docker driver" >&2; exit 1; }
docker image inspect "$image" > toolchain-image.json
tag="beeftv-wasm-toolchain:${image#sha256:}"
docker tag "$image" "$tag"
[[ "$(docker image inspect "$tag" --format '{{.Id}}')" == "$(docker image inspect "$image" --format '{{.Id}}')" ]] || exit 1
docker buildx build --builder "$builder" --platform linux/amd64 --pull=false --network=none --progress=plain \\
  --build-arg "TOOLCHAIN_IMAGE=$tag" --build-arg FFMPEG_ST=yes \\
  --build-arg "EXTRA_CFLAGS=-O3 -msimd128" -f Dockerfile.offline --output type=local,dest=. . 2>&1 | tee build.log
python3 -c 'import hashlib,pathlib; [print(hashlib.sha256(p.read_bytes()).hexdigest(), p) for p in sorted(pathlib.Path("dist/esm").glob("ffmpeg-core.*"))]' > rebuilt-binary-sha256.txt
""")
    for name in ("prepare-toolchain.sh", "build-offline.sh"):
        (destination / name).chmod(0o755)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path)
    parser.add_argument("--version", help="BeefTV release version, e.g. 1.7.23")
    parser.add_argument("--output-dir", type=Path, default=Path("dist"))
    parser.add_argument("--cache-dir", type=Path, default=Path(".local/cache/ffmpeg-wasm-sources"))
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--binary-dir", type=Path, help="Verify the installed ESM core against the source lock")
    parser.add_argument("--prepare-build", type=Path)
    parser.add_argument("--bundle-dir", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    bundled_lock = args.bundle_dir / "source-lock.json"
    lock = load_lock(args.lock or (bundled_lock if bundled_lock.is_file() else DEFAULT_LOCK))
    if args.binary_dir:
        verify_binary(args.binary_dir, lock)
    if args.verify:
        result = verify_archive(args.verify, lock)
        print(json.dumps({"verified": True, "provenance": result["provenance"]["status"]}))
    elif args.prepare_build:
        print(prepare_build(args.bundle_dir, args.prepare_build, lock))
    elif args.version:
        print(collect(lock, args.version, args.output_dir, args.cache_dir, args.offline))
    else:
        parser.error("Use --version, --verify or --prepare-build")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, tarfile.TarError) as error:
        raise SystemExit(str(error)) from error
