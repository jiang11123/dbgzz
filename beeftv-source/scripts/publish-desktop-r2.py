#!/usr/bin/env python3
"""Publish signed desktop releases to R2, with a legacy COS feed bridge.

stage uploads immutable version objects; activate requires a published GitHub
release and atomically changes latest after public verification. Credentials stay
in AWS environment variables. No bucket configuration or permissions are changed.
"""

import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
from urllib.parse import urlsplit
import uuid
from desktop_cos_store import COSStore, PublishError, fingerprint

PLATFORMS = {"darwin-arm64", "darwin-amd64", "windows-amd64", "linux-amd64"}
PREFIX = "beeftv"
LATEST = f"{PREFIX}/desktop-update.json"
IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-store, max-age=0"
MAX_MANIFEST = 2 * 1024 * 1024
GITHUB_LATEST_FEED = "https://github.com/glanderness/BeefTV/releases/latest/download/desktop-update.json"
COS_PUBLIC_BASE = "https://beeftv-components-1481187348.cos.ap-guangzhou.myqcloud.com/beeftv"
R2_PUBLIC_BASE = "https://updates.beefapi.com/beeftv"
PROBE_BYTES = 1024


def version_tuple(version):
    if not isinstance(version, str) or not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise PublishError("Expected a stable vMAJOR.MINOR.PATCH version")
    return tuple(map(int, version[1:].split(".")))


def run(command):
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=600,
                              env={**os.environ, "AWS_PAGER": "", "AWS_EC2_METADATA_DISABLED": "true",
                                   "AWS_REQUEST_CHECKSUM_CALCULATION": "when_required",
                                   "AWS_RESPONSE_CHECKSUM_VALIDATION": "when_required"})
    except (OSError, subprocess.TimeoutExpired):
        raise PublishError("Required release command unavailable or timed out") from None


def signed_payload(path, verifier):
    if Path(path).stat().st_size > MAX_MANIFEST:
        raise PublishError("Manifest is too large")
    # The Go verifier reads BEEFTV_UPDATER_PUBLIC_KEY itself; no key in argv/logs.
    result = run([str(verifier), "verify", "--envelope", str(path)])
    if result.returncode:
        raise PublishError("Manifest signature or schema verification failed")
    try:
        envelope = json.loads(Path(path).read_bytes())
        payload = json.loads(base64.b64decode(envelope["payload"], validate=True))
        version_tuple(payload["version"])
        return payload
    except (ValueError, KeyError, TypeError):
        raise PublishError("Invalid signed manifest payload") from None


class S3:
    def __init__(self, endpoint, bucket):
        self.base = ["aws", "--endpoint-url", endpoint, "--region", "auto", "s3api"]
        self.bucket = bucket
        self.provider = "r2"

    def get(self, key, destination):
        head = run(self.base + ["head-object", "--bucket", self.bucket, "--key", key])
        if head.returncode:
            if re.search(r"\((404|NoSuchKey|NotFound)\)", head.stderr):
                return None
            raise PublishError(f"Cannot inspect release object: {key}")
        etag = json.loads(head.stdout)["ETag"]
        result = run(self.base + ["get-object", "--bucket", self.bucket, "--key", key,
                                  "--if-match", etag, str(destination)])
        if result.returncode:
            raise PublishError(f"Cannot read stable release object: {key}")
        return etag

    def put(self, key, source, cache_control, etag=None):
        condition = ["--if-match", etag] if etag else ["--if-none-match", "*"]
        result = run(self.base + ["put-object", "--bucket", self.bucket, "--key", key,
                                  "--body", str(source), "--cache-control", cache_control,
                                  "--content-type", {".json": "application/json", ".zip": "application/zip", ".dmg": "application/x-apple-diskimage", ".exe": "application/vnd.microsoft.portable-executable", ".deb": "application/vnd.debian.binary-package"}.get(Path(key).suffix, "application/octet-stream")] + condition)
        if result.returncode:
            if re.search(r"\((412|PreconditionFailed|ConditionalRequestConflict)\)", result.stderr):
                return False
            raise PublishError(f"Conditional release upload failed: {key}")
        return True

    def delete_probe(self, key):
        if not key.startswith(f"{PREFIX}/.publication-probes/"):
            raise PublishError("Refusing to delete a release object")
        if run(self.base + ["delete-object", "--bucket", self.bucket, "--key", key]).returncode:
            raise PublishError("Conditional-write probe cleanup failed")

    def check_conditions(self):
        """Detect S3 implementations that ignore conditional PUT headers."""
        key = f"{PREFIX}/.publication-probes/{uuid.uuid4().hex}"
        with tempfile.TemporaryDirectory(prefix="beeftv-store-probe-") as directory:
            first, second, readback = (Path(directory) / name for name in ("first", "second", "readback"))
            first.write_bytes(b"BeefTV conditional-write probe A")
            second.write_bytes(b"BeefTV conditional-write probe B")
            try:
                if not self.put(key, first, REVALIDATE):
                    raise PublishError("Cannot create conditional-write probe")
                etag = self.get(key, readback)
                if etag is None or fingerprint(readback) != fingerprint(first):
                    raise PublishError("Conditional-write probe readback failed")
                if self.put(key, second, REVALIDATE):
                    raise PublishError("Storage ignores If-None-Match; publication is blocked")
                if self.put(key, second, REVALIDATE, etag='"beeftv-invalid-etag"'):
                    raise PublishError("Storage ignores If-Match; activation is blocked")
                if self.get(key, readback) != etag or fingerprint(readback) != fingerprint(first):
                    raise PublishError("Rejected conditional writes changed stored bytes")
                if not self.put(key, second, REVALIDATE, etag=etag):
                    raise PublishError("Storage rejects valid If-Match; activation is blocked")
                if self.get(key, readback) is None or fingerprint(readback) != fingerprint(second):
                    raise PublishError("Conditional replacement readback failed")
                # A stale ETag must still be rejected after a successful replace.
                if self.put(key, first, REVALIDATE, etag=etag):
                    raise PublishError("Storage accepts stale If-Match; activation is blocked")
                if self.get(key, readback) is None or fingerprint(readback) != fingerprint(second):
                    raise PublishError("Rejected stale write changed stored bytes")
            finally:
                failure = sys.exc_info()[1]
                try:
                    self.delete_probe(key)
                except PublishError:
                    if failure is not None:
                        raise PublishError(f"{failure}; conditional-write probe cleanup also failed") from None
                    raise


class PublicHTTP:
    def __init__(self, opener=urllib.request.urlopen, verified=None):
        self.opener = opener
        self.verified = verified

    def check(self, url, expected_size, expected_hash, *, version):
        version_tuple(version)
        digest = hashlib.sha256()
        size = 0
        prefix = b""
        # Mutable feeds are always read in full, even if a receipt names them.
        reusable = expected_size > PROBE_BYTES and not urlsplit(url).path.endswith(".json")
        prior = self.verified.get(url) if reusable and self.verified is not None else None
        try:
            headers = {"Cache-Control": "no-cache", "User-Agent": f"BeefTV-Desktop-Updater/{version}"}
            if prior is not None:
                if (not isinstance(prior, dict) or prior.get("size") != expected_size
                        or prior.get("sha256") != expected_hash
                        or not isinstance(prior.get("etag"), str)
                        or not re.fullmatch(r'"[^"\x00-\x20\x7f]+"', prior.get("etag", ""))
                        or not isinstance(prior.get("prefixSHA256"), str)
                        or not re.fullmatch(r"[a-f0-9]{64}", prior.get("prefixSHA256", ""))):
                    raise PublishError("Public verification receipt does not match this asset")
                # Prove the endpoint enforces the precondition, rather than
                # accepting an implementation that echoes the supplied ETag.
                mismatch = '"beeftv-mismatch-' + uuid.uuid4().hex + '"'
                rejection = urllib.request.Request(url, headers={**headers, "Range": "bytes=0-0", "If-Match": mismatch})
                try:
                    with self.opener(rejection, timeout=60):
                        raise PublishError("Public endpoint accepted a mismatched ETag")
                except urllib.error.HTTPError as error:
                    error.close()
                    if error.code != 412:
                        raise PublishError("Public endpoint did not confirm its ETag precondition") from None
                headers.update({"Range": f"bytes=0-{PROBE_BYTES - 1}", "If-Match": prior["etag"]})
            request = urllib.request.Request(url, headers=headers)
            with self.opener(request, timeout=60) as response:
                if prior is not None:
                    if (response.status != 206 or response.headers.get("ETag") != prior["etag"]
                            or response.headers.get("Content-Range") != f"bytes 0-{PROBE_BYTES - 1}/{expected_size}"
                            or response.headers.get("Content-Length") != str(PROBE_BYTES)):
                        raise PublishError("Previously verified public object changed or rejected its range probe")
                    data = response.read(PROBE_BYTES + 1)
                    if len(data) != PROBE_BYTES or hashlib.sha256(data).hexdigest() != prior["prefixSHA256"]:
                        raise PublishError("Previously verified public object probe differs")
                    return
                if response.status != 200:
                    raise PublishError("Public object did not return HTTP 200")
                etag = response.headers.get("ETag", "")
                while chunk := response.read(1024 * 1024):
                    if len(prefix) < PROBE_BYTES:
                        prefix += chunk[:PROBE_BYTES - len(prefix)]
                    size += len(chunk)
                    if size > expected_size:
                        raise PublishError("Public object size mismatch")
                    digest.update(chunk)
        except (OSError, ValueError, http.client.HTTPException):
            raise PublishError("Public object readback failed") from None
        if size != expected_size or digest.hexdigest() != expected_hash:
            raise PublishError("Public object size/hash mismatch")
        if reusable and self.verified is not None and re.fullmatch(r'"[^"\x00-\x20\x7f]+"', etag):
            self.verified[url] = {"size": size, "sha256": expected_hash, "etag": etag,
                                  "prefixSHA256": hashlib.sha256(prefix).hexdigest()}


def verification_binding(manifest, args):
    owner = {name: os.environ.get(name, "") for name in
             ("GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB")}
    if not all(owner.values()):
        raise PublishError("Verification receipts require the same GitHub run, attempt and job")
    return {"schema": 1, "manifestSHA256": fingerprint(manifest)[1], "owner": owner,
            "provider": args.provider, "endpoint": args.endpoint_url, "region": args.region,
            "bucket": args.bucket, "publicBase": args.public_base}


def read_verification_receipt(path, binding):
    if not path.exists():
        return {}  # A fresh invocation without proof must perform full checks.
    if path.stat().st_size > MAX_MANIFEST:
        raise PublishError("Public verification receipt is too large")
    try:
        receipt = json.loads(path.read_bytes())
    except (ValueError, UnicodeError):
        raise PublishError("Public verification receipt is not valid JSON") from None
    if (not isinstance(receipt, dict) or any(receipt.get(k) != v for k, v in binding.items())
            or not isinstance(receipt.get("objects"), dict)):
        raise PublishError("Public verification receipt belongs to different release inputs or job")
    return receipt["objects"]


def write_verification_receipt(path, binding, objects):
    # This local proof is never uploaded or shared across jobs. Publish it only
    # after the entire stage succeeds; failed stages leave no usable receipt.
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            json.dump({**binding, "objects": objects}, output)
            output.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def require_github_release(payload, manifest, public):
    result = run(["gh", "api", f"repos/glanderness/BeefTV/releases/tags/{payload['version']}"])
    if result.returncode:
        raise PublishError("Cannot verify published GitHub release")
    release = json.loads(result.stdout)
    if (release.get("draft") is not False or release.get("prerelease") is not False
            or not release.get("published_at") or release.get("tag_name") != payload["version"]
            or release.get("target_commitish") != payload["commit"]):
        raise PublishError("GitHub release is not published for this exact commit")
    expected = {f"BeefTV-{payload['version']}-{platform}.zip" for platform in PLATFORMS}
    expected.add("desktop-update.json")
    uploaded = {asset.get("name") for asset in release.get("assets", []) if asset.get("state") == "uploaded"}
    if not expected.issubset(uploaded):
        raise PublishError("GitHub release assets are incomplete")
    latest = run(["gh", "api", "repos/glanderness/BeefTV/releases/latest"])
    if latest.returncode or json.loads(latest.stdout).get("tag_name") != payload["version"]:
        raise PublishError("GitHub latest does not point to this version")
    public.check(GITHUB_LATEST_FEED, *fingerprint(manifest), version=payload["version"])


def require_terminal_publisher(original_lock):
    try:
        document = json.loads(original_lock)
        owner = document["owner"]
        repository, run_id, attempt = (owner[name] for name in ("GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"))
        if (repository != "glanderness/BeefTV" or not re.fullmatch(r"[1-9][0-9]*", run_id)
                or not re.fullmatch(r"[1-9][0-9]*", attempt)
                or not re.fullmatch(r"[a-zA-Z0-9_-]+", owner.get("GITHUB_JOB", ""))):
            raise PublishError("Recovery requires the original official GitHub publisher identity")
    except (ValueError, KeyError, TypeError):
        raise PublishError("Recovery requires the original GitHub publisher document") from None
    result = run(["gh", "api", f"repos/{repository}/actions/runs/{run_id}/attempts/{attempt}"])
    if result.returncode:
        raise PublishError("Cannot confirm the original GitHub publisher has ended")
    try:
        metadata = json.loads(result.stdout)
        if (not isinstance(metadata, dict) or metadata.get("status") != "completed"
                or metadata.get("id") != int(run_id) or metadata.get("run_attempt") != int(attempt)
                or not isinstance(metadata.get("repository"), dict)
                or metadata["repository"].get("full_name") != repository):
            raise PublishError("Original GitHub publisher is not confirmed terminal")
    except (ValueError, TypeError):
        raise PublishError("Invalid original GitHub publisher status") from None


def recovery_document(path):
    if path.stat().st_size > 8192:
        raise PublishError("Recovery document is too large")
    return path.read_bytes()


class Publisher:
    def __init__(self, store, public, verifier, public_base, release_check=require_github_release,
                 feed_public_base=None):
        self.store, self.public, self.verifier = store, public, verifier
        self.public_base = public_base.rstrip("/")
        self.feed_public_base = (feed_public_base or public_base).rstrip("/")
        self.release_check = release_check

    def load(self, manifest):
        payload = signed_payload(manifest, self.verifier)
        if set(payload["platforms"]) != PLATFORMS:
            raise PublishError("Manifest must contain exactly all four desktop platforms")
        for platform, asset in payload["platforms"].items():
            name = f"BeefTV-{payload['version']}-{platform}.zip"
            if asset["url"] != f"{self.public_base}/{payload['version']}/{name}":
                raise PublishError("Manifest asset URL does not match immutable public version path")
            if type(asset["size"]) is not int or not 0 < asset["size"] <= 2 << 30:
                raise PublishError("Invalid desktop archive size")
            if not re.fullmatch(r"[a-f0-9]{64}", asset["sha256"]):
                raise PublishError("Invalid desktop archive hash")
        return payload

    def immutable_put(self, key, source):
        expected = fingerprint(source)
        with tempfile.TemporaryDirectory(prefix="beeftv-release-check-") as directory:
            previous = Path(directory) / "object"
            etag = self.store.get(key, previous)
            if etag is None:
                self.store.put(key, source, IMMUTABLE)
                # Read back our upload or the immutable create another publisher won.
                etag = self.store.get(key, previous)
            if etag is None or fingerprint(previous) != expected:
                raise PublishError(f"Immutable version object already differs: {key}")

    def public_check(self, payload, manifest):
        for asset in payload["platforms"].values():
            self.public.check(asset["url"], asset["size"], asset["sha256"], version=payload["version"])
        size, sha = fingerprint(manifest)
        self.public.check(f"{self.public_base}/{payload['version']}/desktop-update.json", size, sha, version=payload["version"])

    def installer_sources(self, payload, assets_dir):
        suffixes = {"darwin-arm64": ".dmg", "darwin-amd64": ".dmg",
                    "windows-amd64": "-setup.exe", "linux-amd64": ".deb"}
        sources = []
        for platform, suffix in suffixes.items():
            name = f"BeefTV-{payload['version']}-{platform}{suffix}"
            source = Path(assets_dir) / name
            if not source.is_file() or source.stat().st_size == 0:
                raise PublishError(f"Installer missing: {name}")
            sources.append((f"{PREFIX}/{payload['version']}/{name}", source))
        return sources

    def check_installers(self, payload, sources):
        for key, source in sources:
            self.public.check(f"{self.public_base}/{payload['version']}/{source.name}",
                              *fingerprint(source), version=payload['version'])

    def stage(self, manifest, assets_dir, with_installers=False):
        payload = self.load(manifest)
        sources = []
        for platform, asset in payload["platforms"].items():
            name = f"BeefTV-{payload['version']}-{platform}.zip"
            source = Path(assets_dir) / name
            if not source.is_file() or fingerprint(source) != (asset["size"], asset["sha256"]):
                raise PublishError(f"Local archive missing or size/hash mismatch: {name}")
            sources.append((f"{PREFIX}/{payload['version']}/{name}", source))
        installers = self.installer_sources(payload, assets_dir) if with_installers else []
        for key, source in sources + installers:
            self.immutable_put(key, source)
        self.check_installers(payload, installers)
        self.immutable_put(f"{PREFIX}/{payload['version']}/desktop-update.json", manifest)
        self.public_check(payload, manifest)
        return payload["version"]

    def activate(self, manifest, installer_dir=None, *, require_active_source=False):
        payload = self.load(manifest)
        if installer_dir is not None:
            self.check_installers(payload, self.installer_sources(payload, installer_dir))
        self.release_check(payload, manifest, self.public)
        self.public_check(payload, manifest)
        if require_active_source:
            # A bridge may only follow the already activated canonical feed.
            self.public.check(f"{self.public_base}/desktop-update.json", *fingerprint(manifest),
                              version=payload["version"])
        with tempfile.TemporaryDirectory(prefix="beeftv-release-latest-") as directory:
            previous = Path(directory) / "previous.json"
            etag = self.store.get(LATEST, previous)
            if etag is not None:
                old = signed_payload(previous, self.verifier)
                if version_tuple(old["version"]) > version_tuple(payload["version"]):
                    raise PublishError("Refusing to downgrade latest")
                if version_tuple(old["version"]) == version_tuple(payload["version"]):
                    if fingerprint(previous) != fingerprint(manifest):
                        raise PublishError("Same latest version has different signed content")
                    self.public.check(f"{self.feed_public_base}/desktop-update.json", *fingerprint(manifest), version=payload["version"])
                    return payload["version"]
                backup = f"{PREFIX}/latest-backups/{old['version']}-{fingerprint(previous)[1]}.json"
                self.immutable_put(backup, previous)
            if not self.store.put(LATEST, manifest, REVALIDATE, etag=etag):
                raise PublishError("Latest changed concurrently; verify and rerun activation")
            # Check both authoritative storage and the public feed after the atomic PUT.
            current = Path(directory) / "current.json"
            if self.store.get(LATEST, current) is None or fingerprint(current) != fingerprint(manifest):
                raise PublishError("Latest storage readback mismatch")
            self.public.check(f"{self.feed_public_base}/desktop-update.json", *fingerprint(manifest), version=payload["version"])
        return payload["version"]

    def resume(self, manifest, original_lock, original_claim, *, confirm_no_inflight=False,
               confirm_writers_frozen=False, confirm_no_unlock_attempt=False, installer_dir=None,
               require_active_source=False):
        if (getattr(self.store, "provider", None) != "cos" or not confirm_no_inflight
                or not confirm_writers_frozen or not confirm_no_unlock_attempt):
            raise PublishError("COS recovery requires explicit confirmation: all writers frozen, no in-flight PUT and no prior unlock attempt")
        payload = self.load(manifest)
        require_terminal_publisher(original_lock)
        if installer_dir is not None:
            self.check_installers(payload, self.installer_sources(payload, installer_dir))
        self.release_check(payload, manifest, self.public)
        self.public_check(payload, manifest)
        if require_active_source:
            self.public.check(f"{self.public_base}/desktop-update.json", *fingerprint(manifest),
                              version=payload["version"])
        # The store validates live lock/claim bytes after external checks, then
        # completes only this already claimed signed envelope under its old nonce.
        self.store.resume(LATEST, manifest, original_lock, original_claim)
        self.public.check(f"{self.feed_public_base}/desktop-update.json", *fingerprint(manifest), version=payload["version"])
        return payload["version"]


def storage_config(provider, endpoint, region, bucket, public_base):
    for url in (endpoint, public_base):
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.port is not None):
            raise PublishError("Release endpoint and public base must be plain HTTPS URLs")
    if provider == "r2":
        if not re.fullmatch(r"https://[a-f0-9]{32}\.r2\.cloudflarestorage\.com/?", endpoint) or region != "auto":
            raise PublishError("R2 credentials require an account R2 endpoint and auto region")
    elif provider == "cos":
        if (not re.fullmatch(r"ap-[a-z]+(?:-[a-z]+)?", region)
                or endpoint.rstrip("/") != f"https://cos.{region}.myqcloud.com"
                or not re.fullmatch(r"[a-z0-9][a-z0-9-]*-[0-9]+", bucket)):
            raise PublishError("COS credentials require a matching regional COS endpoint and bucket with APPID")
        if public_base.rstrip("/") != f"https://{bucket}.cos.{region}.myqcloud.com/{PREFIX}":
            raise PublishError("COS releases require their direct bucket public base")
    else:
        raise PublishError("Unsupported release storage provider")
    return COSStore(bucket, region) if provider == "cos" else S3(endpoint, bucket)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check-store", "stage", "activate", "bridge-cos", "resume", "resume-cos-bridge"])
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--assets-dir", type=Path)
    parser.add_argument("--with-installers", action="store_true")
    parser.add_argument("--verification-receipt", type=Path,
                        help="Same-job stage proof for bounded activation probes; never reuse across runs")
    parser.add_argument("--lock-document", type=Path, help="Exact original COS publisher lock document for resume")
    parser.add_argument("--claim-document", type=Path, help="Exact original COS ETag claim document for resume")
    parser.add_argument("--confirm-no-inflight-put", action="store_true", help="Operator confirmed original remote PUT requests have ended; required for resume")
    parser.add_argument("--confirm-writers-frozen", action="store_true", help="Operator froze every feed writer and confirmed no successor publication; required for resume")
    parser.add_argument("--confirm-no-unlock-attempt", action="store_true", help="Original publisher logs prove no lock DELETE was ever sent; required for resume")
    parser.add_argument("--verifier", type=Path, help="Binary built from backend/cmd/update-release")
    parser.add_argument("--provider", choices=["cos", "r2"], default="r2")
    parser.add_argument("--endpoint-url", required=True)
    parser.add_argument("--region")
    parser.add_argument("--bucket")
    parser.add_argument("--public-base")
    args = parser.parse_args()
    args.region = args.region or ("auto" if args.provider == "r2" else "ap-guangzhou")
    args.bucket = args.bucket or ("beeftv-releases" if args.provider == "r2" else "beeftv-components-1481187348")
    args.public_base = args.public_base or (R2_PUBLIC_BASE if args.provider == "r2" else COS_PUBLIC_BASE)
    try:
        if args.verification_receipt and args.command not in ("stage", "activate"):
            raise PublishError("Verification receipts are only supported for stage and activate")
        store = storage_config(args.provider, args.endpoint_url, args.region, args.bucket, args.public_base)
        if args.command != "check-store" and (args.manifest is None or args.verifier is None):
            raise PublishError("Publication requires --manifest and --verifier")
        is_bridge = args.command in ("bridge-cos", "resume-cos-bridge")
        if args.command in ("resume", "resume-cos-bridge") and (args.provider != "cos" or args.lock_document is None
                or args.claim_document is None or not args.confirm_no_inflight_put
                or not args.confirm_writers_frozen or not args.confirm_no_unlock_attempt):
            raise PublishError("Resume requires COS, original lock/claim documents and all three recovery confirmations")
        if is_bridge and (args.provider != "cos" or args.with_installers
                or args.public_base.rstrip("/") != COS_PUBLIC_BASE):
            raise PublishError("Bridge requires the original COS feed destination and no installer staging")
        # COS proves native forbid-overwrite for immutable objects and locks;
        # legacy R2 proves its native conditional PUT headers. Never assume S3
        # compatibility supplies either primitive.
        store.check_conditions()
        if args.command == "check-store":
            print("Release storage conditional writes verified")
            return 0
        # Snapshot the verified envelope so a changed local file cannot be activated.
        with tempfile.TemporaryDirectory(prefix="beeftv-release-manifest-") as directory:
            manifest = Path(directory) / "desktop-update.json"
            if args.manifest.stat().st_size > MAX_MANIFEST:
                raise PublishError("Manifest is too large")
            manifest.write_bytes(args.manifest.read_bytes())
            binding, verified = None, None
            if args.verification_receipt:
                binding = verification_binding(manifest, args)
                if args.command == "stage":
                    args.verification_receipt.unlink(missing_ok=True)
                    verified = {}
                else:
                    verified = read_verification_receipt(args.verification_receipt, binding)
            # The R2 custom-domain cache can ignore If-Match on a cache hit.
            # Only COS can reuse HTTP proofs; R2 always rehashes full responses.
            public = PublicHTTP(verified=verified if args.provider == "cos" else None)
            publisher = Publisher(store, public, args.verifier.resolve(),
                                  R2_PUBLIC_BASE if is_bridge else args.public_base,
                                  feed_public_base=args.public_base)
            assets_dir = args.assets_dir or args.manifest.parent
            if args.command == "stage":
                version = publisher.stage(manifest, assets_dir, args.with_installers)
                if args.verification_receipt:
                    write_verification_receipt(args.verification_receipt, binding, verified)
            elif args.command in ("resume", "resume-cos-bridge"):
                version = publisher.resume(manifest, recovery_document(args.lock_document), recovery_document(args.claim_document),
                                           confirm_no_inflight=args.confirm_no_inflight_put,
                                           confirm_writers_frozen=args.confirm_writers_frozen,
                                           confirm_no_unlock_attempt=args.confirm_no_unlock_attempt,
                                           installer_dir=assets_dir if args.with_installers else None,
                                           require_active_source=is_bridge)
            elif args.command == "bridge-cos":
                version = publisher.activate(manifest, require_active_source=True)
            else:
                version = publisher.activate(manifest, assets_dir if args.with_installers else None)
        print(f"{args.command} verified: {version}")
    except PublishError as error:
        print(f"Desktop publication failed: {error}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError):
        # Never include subprocess stderr, request headers or credential-bearing URLs.
        print("Desktop publication failed; latest was not verified. Inspect release inputs and storage state before retrying.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
