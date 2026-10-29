"""No cloud writes: fake S3, actual local HTTP readback, existing verifier boundary."""

import base64
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess
import tempfile
import threading
import unittest
import io
from contextlib import redirect_stderr
from unittest.mock import Mock, patch
import urllib.request
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location("publish_desktop_r2", Path(__file__).with_name("publish-desktop-r2.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.writes = []
        self.reads = []
        self.before_put = None

    def get(self, key, destination):
        if key not in self.objects:
            return None
        content = self.objects[key]
        self.reads.append((key, len(content)))
        Path(destination).write_bytes(content)
        return hashlib.sha256(content).hexdigest()

    def put(self, key, source, cache_control, etag=None):
        if self.before_put:
            self.before_put(key)
        current = self.objects.get(key)
        if etag is None and current is not None:
            return False
        if etag is not None and (current is None or hashlib.sha256(current).hexdigest() != etag):
            return False
        self.objects[key] = Path(source).read_bytes()
        self.writes.append((key, cache_control))
        return True


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.store = FakeS3()
        self.legacy_store = FakeS3()
        store = self.store
        self.public_requests = []
        requests = self.public_requests
        self.transfers = []
        self.range_mode = "normal"
        self.etag_mode = "strong"
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                agent = self.headers.get("User-Agent", "")
                requests.append((self.path, agent))
                if not re.fullmatch(r"BeefTV-Desktop-Updater/v\d+\.\d+\.\d+", agent):
                    self.send_error(403)
                    return
                origin = fixture.legacy_store if self.headers.get("X-Test-Origin") == "legacy" else store
                content = origin.objects.get(self.path.lstrip("/"))
                if content is None:
                    self.send_error(404)
                    return
                etag = '"' + hashlib.sha256(content).hexdigest() + '"'
                if fixture.range_mode == "echo" and self.headers.get("If-Match"):
                    etag = self.headers['If-Match']
                if fixture.etag_mode == "weak":
                    etag = "W/" + etag
                if self.headers.get("If-Match") not in (None, etag) and fixture.range_mode != "ignore-if-match":
                    self.send_error(412)
                    return
                status = 200
                if self.headers.get("Range") and fixture.range_mode != "ignored":
                    status = 206
                    total = len(content)
                    content = content[:release.PROBE_BYTES]
                    if fixture.range_mode == "corrupt-prefix":
                        content = b"!" * len(content)
                    if fixture.range_mode == "truncated":
                        content = content[:7]
                    self.send_response(status)
                    self.send_header("Content-Range", f"bytes 0-{release.PROBE_BYTES - 1}/{total}")
                    self.send_header("Content-Length", str(release.PROBE_BYTES))
                else:
                    self.send_response(status)
                    self.send_header("Content-Length", str(len(content)))
                if fixture.etag_mode != "missing":
                    self.send_header("ETag", etag)
                self.end_headers()
                fixture.transfers.append((self.path, status, len(content)))
                try:
                    self.wfile.write(content)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

        def opener(request, timeout):
            url = f"http://127.0.0.1:{self.server.server_port}{urlsplit(request.full_url).path}"
            headers = dict(request.header_items())
            if urlsplit(request.full_url).hostname == "legacy.example":
                headers["X-Test-Origin"] = "legacy"
            return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout)

        # Cryptography belongs to the existing Go verifier. Exercise invocation
        # and its failure result here, without replacing production verification.
        self.verifier = patch.object(release, "run", return_value=subprocess.CompletedProcess([], 0, "", ""))
        self.verify_command = self.verifier.start()
        self.addCleanup(self.verifier.stop)
        self.publisher = release.Publisher(self.store, release.PublicHTTP(opener), "/tmp/update-release",
                                           "https://updates.beefapi.com/beeftv", lambda *args: None)

    def bridge(self):
        return release.Publisher(self.legacy_store, self.publisher.public, "/tmp/update-release",
                                 release.R2_PUBLIC_BASE, lambda *args: None,
                                 feed_public_base="https://legacy.example/beeftv")

    def test_bridge_requires_the_exact_already_active_r2_feed(self):
        old = self.manifest()
        self.publisher.stage(old, self.root)
        self.publisher.activate(old)
        newer = self.manifest("v1.5.8")
        self.publisher.stage(newer, self.root)
        with self.assertRaises(release.PublishError):
            self.bridge().activate(newer, require_active_source=True)
        self.assertEqual(self.legacy_store.writes, [])
        self.assertEqual(self.store.objects[release.LATEST], old.read_bytes())

    def test_bridge_updates_only_legacy_feed_and_backup_with_original_signed_bytes(self):
        old = self.manifest()
        old_bytes = old.read_bytes()
        self.legacy_store.objects[release.LATEST] = old_bytes
        newer = self.manifest("v1.5.8")
        self.publisher.stage(newer, self.root)
        self.publisher.activate(newer)
        bridge = self.bridge()
        self.assertEqual(bridge.activate(newer, require_active_source=True), "v1.5.8")
        self.assertEqual(self.legacy_store.objects[release.LATEST], newer.read_bytes())
        self.assertEqual(len(self.legacy_store.writes), 2)
        self.assertTrue(all(key == release.LATEST or key.startswith("beeftv/latest-backups/")
                            for key, _ in self.legacy_store.writes))
        self.assertIn(old_bytes, self.legacy_store.objects.values())
        self.assertFalse(any(key.endswith((".zip", ".exe", ".dmg", ".deb"))
                             for key in self.legacy_store.objects))
        before = list(self.legacy_store.writes)
        bridge.activate(newer, require_active_source=True)
        self.assertEqual(self.legacy_store.writes, before)

    def test_bridge_rejects_corrupt_r2_package_before_any_cos_write(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        self.publisher.activate(manifest)
        key = next(key for key in self.store.objects if key.endswith(".zip"))
        self.store.objects[key] = b"changed"
        with self.assertRaises(release.PublishError):
            self.bridge().activate(manifest, require_active_source=True)
        self.assertEqual(self.legacy_store.writes, [])

    def test_bridge_failure_does_not_rollback_canonical_r2_feed(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        self.publisher.activate(manifest)
        def competing_writer(key):
            if key == release.LATEST:
                self.legacy_store.objects[key] = b"concurrent feed"
        self.legacy_store.before_put = competing_writer
        with self.assertRaisesRegex(release.PublishError, "changed concurrently"):
            self.bridge().activate(manifest, require_active_source=True)
        self.assertEqual(self.store.objects[release.LATEST], manifest.read_bytes())

    def test_bridge_resume_requires_active_r2_and_checks_legacy_feed_after_recovery(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        bridge = self.bridge()
        bridge.store.provider = "cos"
        bridge.store.resume = Mock(side_effect=lambda key, source, *_:
                                   bridge.store.objects.__setitem__(key, source.read_bytes()))
        confirmations = dict(confirm_no_inflight=True, confirm_writers_frozen=True,
                             confirm_no_unlock_attempt=True, require_active_source=True)
        with patch.object(release, "require_terminal_publisher"):
            with self.assertRaises(release.PublishError):
                bridge.resume(manifest, b"lock", b"claim", **confirmations)
            bridge.store.resume.assert_not_called()
            self.publisher.activate(manifest)
            self.assertEqual(bridge.resume(manifest, b"lock", b"claim", **confirmations), "v1.5.7")
        bridge.store.resume.assert_called_once_with(release.LATEST, manifest, b"lock", b"claim")
        self.assertEqual(self.legacy_store.objects[release.LATEST], manifest.read_bytes())

    def manifest(self, version="v1.5.7", omit=None, copies=32):
        platforms = {}
        for platform in sorted(release.PLATFORMS):
            if platform == omit:
                continue
            name = f"BeefTV-{version}-{platform}.zip"
            data = (version + platform).encode() * copies
            (self.root / name).write_bytes(data)
            platforms[platform] = {"url": f"https://updates.beefapi.com/beeftv/{version}/{name}",
                                   "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        payload = {"schema": 1, "version": version, "commit": "a" * 40, "notes": "test release", "platforms": platforms}
        path = self.root / f"{version}.json"
        path.write_text(json.dumps({"payload": base64.b64encode(json.dumps(payload).encode()).decode(), "signature": "fixture"}))
        return path

    def test_installers_are_required_before_any_write_and_read_back_before_activation(self):
        manifest = self.manifest()
        with self.assertRaisesRegex(release.PublishError, 'Installer missing'):
            self.publisher.stage(manifest, self.root, with_installers=True)
        self.assertEqual(self.store.writes, [])
        names = ['darwin-arm64.dmg', 'darwin-amd64.dmg', 'windows-amd64-setup.exe', 'linux-amd64.deb']
        for name in names:
            (self.root / ('BeefTV-v1.5.7-' + name)).write_bytes(name.encode())
        self.publisher.stage(manifest, self.root, with_installers=True)
        self.assertNotIn(release.LATEST, self.store.objects)
        key = release.PREFIX + '/v1.5.7/BeefTV-v1.5.7-linux-amd64.deb'
        self.assertEqual(self.store.objects[key], b'linux-amd64.deb')
        self.store.objects[key] = b'corrupt'
        with self.assertRaises(release.PublishError):
            self.publisher.activate(manifest, self.root)
        self.assertNotIn(release.LATEST, self.store.objects)

    def test_complete_stage_does_not_activate_and_retries_are_idempotent(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        self.assertNotIn(release.LATEST, self.store.objects)
        self.assertEqual(len(self.store.writes), len(release.PLATFORMS) + 1)
        self.assertTrue(all(agent == "BeefTV-Desktop-Updater/v1.5.7" for _, agent in self.public_requests))
        self.publisher.stage(manifest, self.root)
        self.assertEqual(len(self.store.writes), len(release.PLATFORMS) + 1)
        self.assertEqual(self.verify_command.call_args.args[0], ["/tmp/update-release", "verify", "--envelope", str(manifest)])

    def test_public_readback_uses_updater_user_agent_instead_of_urllib_default(self):
        data = b"public release asset"
        self.store.objects["beeftv/probe"] = data
        url = f"http://127.0.0.1:{self.server.server_port}/beeftv/probe"
        with self.assertRaises(urllib.error.HTTPError) as failure:
            urllib.request.urlopen(url)
        self.assertEqual(failure.exception.code, 403)
        release.PublicHTTP().check(url, len(data), hashlib.sha256(data).hexdigest(), version="v1.5.8")
        self.assertEqual(self.public_requests[-1][1], "BeefTV-Desktop-Updater/v1.5.8")

    def test_same_job_receipt_cuts_activation_to_1k_per_package_and_keeps_full_feeds(self):
        manifest = self.manifest(copies=512)
        for suffix in ['darwin-arm64.dmg', 'darwin-amd64.dmg', 'windows-amd64-setup.exe', 'linux-amd64.deb']:
            (self.root / ('BeefTV-v1.5.7-' + suffix)).write_bytes(suffix.encode() * 512)
        verified = {}
        self.publisher.public.verified = verified
        self.publisher.stage(manifest, self.root, with_installers=True)
        self.assertEqual(len(verified), 8)
        package_bytes = sum(row['size'] for row in verified.values())
        self.assertEqual(sum(n for path, _, n in self.transfers if not path.endswith('.json')), package_bytes)
        self.assertEqual(sum(n for path, n in self.store.reads if not path.endswith('.json')), package_bytes)
        receipt = self.root / 'receipt.json'
        binding = {'schema': 1, 'manifestSHA256': release.fingerprint(manifest)[1], 'job': 'fixture'}
        release.write_verification_receipt(receipt, binding, verified)
        self.publisher.public = release.PublicHTTP(self.publisher.public.opener,
                                                   release.read_verification_receipt(receipt, binding))
        self.transfers.clear()
        self.publisher.activate(manifest, self.root)
        packages = [x for x in self.transfers if not x[0].endswith('.json')]
        self.assertEqual(len(packages), 8)
        self.assertTrue(all(status == 206 and size == 1024 for _, status, size in packages))
        self.assertTrue(all(status == 200 for path, status, _ in self.transfers if path.endswith('.json')))
        self.assertEqual(self.store.objects[release.LATEST], manifest.read_bytes())

    def test_failed_stage_invalidates_old_receipt_and_resume_cannot_use_it(self):
        manifest = self.manifest()
        receipt = self.root / 'receipt.json'
        receipt.write_text('old proof')
        owner = dict(GITHUB_REPOSITORY='glanderness/BeefTV', GITHUB_RUN_ID='123',
                     GITHUB_RUN_ATTEMPT='1', GITHUB_JOB='publish')
        argv = ['publish', 'stage', '--manifest', str(manifest), '--verifier', '/tmp/update-release',
                '--endpoint-url', 'https://cos.ap-guangzhou.myqcloud.com',
                '--verification-receipt', str(receipt)]
        with patch.dict(os.environ, owner), patch('sys.argv', argv), \
                patch.object(release, 'storage_config'), patch.object(release, 'Publisher') as publisher, \
                redirect_stderr(io.StringIO()):
            publisher.return_value.stage.side_effect = release.PublishError('failed full check')
            self.assertEqual(release.main(), 1)
        self.assertFalse(receipt.exists())
        argv[1] = 'resume'
        with patch('sys.argv', argv), patch.object(release, 'storage_config') as storage, \
                redirect_stderr(io.StringIO()):
            self.assertEqual(release.main(), 1)
        storage.assert_not_called()

    def test_r2_cli_rehashes_full_objects_even_with_a_receipt_and_cache_ignoring_if_match(self):
        manifest = self.manifest(copies=512)
        receipt = self.root / 'receipt.json'
        owner = dict(GITHUB_REPOSITORY='glanderness/BeefTV', GITHUB_RUN_ID='123',
                     GITHUB_RUN_ATTEMPT='1', GITHUB_JOB='publish')
        argv = ['publish', 'stage', '--manifest', str(manifest), '--verifier', '/tmp/update-release',
                '--endpoint-url', 'https://' + 'a' * 32 + '.r2.cloudflarestorage.com',
                '--verification-receipt', str(receipt)]
        http, publisher = release.PublicHTTP, release.Publisher
        self.store.check_conditions = Mock()
        self.range_mode = 'ignore-if-match'
        def make_publisher(*args, **kwargs):
            return publisher(*args, **kwargs, release_check=lambda *a: None)
        with patch.dict(os.environ, owner), patch.object(release, 'storage_config', return_value=self.store), \
                patch.object(release, 'PublicHTTP', side_effect=lambda **kw: http(self.publisher.public.opener, **kw)), \
                patch.object(release, 'Publisher', side_effect=make_publisher), patch('builtins.print'):
            with patch('sys.argv', argv):
                self.assertEqual(release.main(), 0)
            self.assertEqual(json.loads(receipt.read_text())['objects'], {})
            self.transfers.clear()
            argv[1] = 'activate'
            with patch('sys.argv', argv):
                self.assertEqual(release.main(), 0)
            packages = [x for x in self.transfers if not x[0].endswith('.json')]
            self.assertEqual(len(packages), 4)
            self.assertTrue(all(status == 200 and size > 1024 for _, status, size in packages))
            key = next(k for k in self.store.objects if k.endswith('.zip'))
            original = self.store.objects[key]
            self.store.objects[key] = original[:1024] + b'!' * (len(original) - 1024)
            with patch('sys.argv', argv), redirect_stderr(io.StringIO()):
                self.assertEqual(release.main(), 1)
            self.assertEqual(self.store.objects[release.LATEST], manifest.read_bytes())

    def test_receipt_cannot_activate_changed_asset_or_suppressed_range(self):
        for mode in ['changed', 'missing', 'ignored', 'corrupt-prefix', 'truncated', 'echo']:
            with self.subTest(mode=mode):
                self.store.objects.clear()
                manifest = self.manifest(copies=512)
                self.publisher.public.verified = {}
                self.range_mode = 'normal'
                self.publisher.stage(manifest, self.root)
                if mode == 'changed':
                    key = next(k for k in self.store.objects if k.endswith('.zip'))
                    self.store.objects[key] = b'corrupt'
                elif mode == 'missing':
                    del self.store.objects[next(k for k in self.store.objects if k.endswith('.zip'))]
                else:
                    self.range_mode = mode
                    if mode == 'echo':
                        key = next(k for k in self.store.objects if k.endswith('.zip'))
                        data = self.store.objects[key]
                        self.store.objects[key] = data[:1024] + b'!' * (len(data) - 1024)
                with self.assertRaises(release.PublishError):
                    self.publisher.activate(manifest)
                self.assertNotIn(release.LATEST, self.store.objects)

    def test_no_strong_etag_or_missing_receipt_keeps_full_hash_verification(self):
        for mode in ['weak', 'missing']:
            with self.subTest(mode=mode):
                self.etag_mode = mode
                self.store.objects.clear()
                self.publisher.public.verified = {}
                manifest = self.manifest(copies=512)
                self.publisher.stage(manifest, self.root)
                self.assertEqual(self.publisher.public.verified, {})
                self.publisher.public.verified = release.read_verification_receipt(self.root / 'absent.json', {})
                self.transfers.clear()
                self.publisher.activate(manifest)
                self.assertTrue(all(status == 200 for _, status, _ in self.transfers))

    def test_receipt_is_bound_to_signed_envelope_storage_and_exact_ci_attempt_job(self):
        manifest = self.manifest()
        args = Mock(provider='cos', endpoint_url='https://cos.ap-guangzhou.myqcloud.com',
                    region='ap-guangzhou', bucket='fixture-123', public_base='https://fixture.example/beeftv')
        owner = dict(GITHUB_REPOSITORY='glanderness/BeefTV', GITHUB_RUN_ID='123',
                     GITHUB_RUN_ATTEMPT='1', GITHUB_JOB='publish')
        with patch.dict(os.environ, owner, clear=True):
            binding = release.verification_binding(manifest, args)
        receipt = self.root / 'receipt.json'
        release.write_verification_receipt(receipt, binding, {})
        for key in ['manifestSHA256', 'provider', 'endpoint', 'region', 'bucket', 'publicBase']:
            with self.subTest(key=key), self.assertRaises(release.PublishError):
                release.read_verification_receipt(receipt, {**binding, key: 'changed'})
        for key in owner:
            with self.subTest(key=key), self.assertRaises(release.PublishError):
                release.read_verification_receipt(receipt, {**binding, 'owner': {**owner, key: 'changed'}})
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(release.PublishError):
            release.verification_binding(manifest, args)

    def test_failed_full_hash_cannot_create_verification_proof(self):
        data = b'fixture' * 1024
        self.store.objects['beeftv/asset.zip'] = data
        public = release.PublicHTTP(self.publisher.public.opener, {})
        with self.assertRaises(release.PublishError):
            public.check('https://updates.beefapi.com/beeftv/asset.zip', len(data), '0' * 64, version='v1.5.7')
        self.assertEqual(public.verified, {})

    def test_malformed_receipt_is_reported_before_publisher_or_latest_write(self):
        manifest = self.manifest()
        receipt = self.root / 'receipt.json'
        owner = dict(GITHUB_REPOSITORY='glanderness/BeefTV', GITHUB_RUN_ID='123',
                     GITHUB_RUN_ATTEMPT='1', GITHUB_JOB='publish')
        argv = ['publish', 'activate', '--manifest', str(manifest), '--verifier', '/tmp/update-release',
                '--endpoint-url', 'https://cos.ap-guangzhou.myqcloud.com', '--verification-receipt', str(receipt)]
        for data in [b'{', b'\xff', b'null']:
            with self.subTest(data=data):
                receipt.write_bytes(data)
                with patch.dict(os.environ, owner), patch('sys.argv', argv), \
                        patch.object(release, 'storage_config'), patch.object(release, 'Publisher') as publisher, \
                        redirect_stderr(io.StringIO()) as error:
                    self.assertEqual(release.main(), 1)
                publisher.assert_not_called()
                self.assertNotIn('Traceback', error.getvalue())
                self.assertNotIn(release.LATEST, self.store.objects)

    def test_incomplete_platform_set_cannot_activate(self):
        manifest = self.manifest(omit="windows-amd64")
        with self.assertRaisesRegex(release.PublishError, "four"):
            self.publisher.activate(manifest)
        self.assertFalse(self.store.writes)

    def test_missing_local_archive_and_bad_hash_write_nothing(self):
        manifest = self.manifest()
        source = self.root / "BeefTV-v1.5.7-windows-amd64.zip"
        source.unlink()
        with self.assertRaisesRegex(release.PublishError, "Local archive"):
            self.publisher.stage(manifest, self.root)
        source.write_bytes(b"wrong archive")
        with self.assertRaisesRegex(release.PublishError, "Local archive"):
            self.publisher.stage(manifest, self.root)
        self.assertFalse(self.store.writes)

    def test_invalid_signature_cannot_upload(self):
        manifest = self.manifest()
        self.verify_command.return_value = subprocess.CompletedProcess([], 1, "", "private diagnostic")
        with self.assertRaisesRegex(release.PublishError, "signature"):
            self.publisher.stage(manifest, self.root)
        self.assertFalse(self.store.writes)

    def test_existing_immutable_version_cannot_be_overwritten(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        key = "beeftv/v1.5.7/BeefTV-v1.5.7-darwin-amd64.zip"
        self.store.objects[key] = b"existing different version content"
        writes = len(self.store.writes)
        with self.assertRaisesRegex(release.PublishError, "Immutable"):
            self.publisher.stage(manifest, self.root)
        self.assertEqual(len(self.store.writes), writes)
        self.assertEqual(self.store.objects[key], b"existing different version content")

    def test_missing_or_corrupt_public_asset_blocks_activation(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        key = "beeftv/v1.5.7/BeefTV-v1.5.7-windows-amd64.zip"
        original = self.store.objects.pop(key)
        with self.assertRaises(release.PublishError):
            self.publisher.activate(manifest)
        self.store.objects[key] = b"x" * len(original)
        with self.assertRaisesRegex(release.PublishError, "hash"):
            self.publisher.activate(manifest)
        self.assertNotIn(release.LATEST, self.store.objects)

    def test_activation_backs_up_latest_and_rejects_downgrade(self):
        old = self.manifest("v1.5.6")
        self.publisher.stage(old, self.root)
        self.publisher.activate(old)
        new = self.manifest()
        self.publisher.stage(new, self.root)
        self.publisher.activate(new)
        backups = [value for key, value in self.store.objects.items() if key.startswith("beeftv/latest-backups/")]
        self.assertEqual(backups, [old.read_bytes()])
        self.assertEqual(self.store.objects[release.LATEST], new.read_bytes())
        self.assertIn((release.LATEST, release.REVALIDATE), self.store.writes)
        with self.assertRaisesRegex(release.PublishError, "downgrade"):
            self.publisher.activate(old)
        self.assertEqual(self.store.objects[release.LATEST], new.read_bytes())

    def test_concurrent_latest_change_is_not_overwritten(self):
        old = self.manifest("v1.5.6")
        self.publisher.stage(old, self.root)
        self.publisher.activate(old)
        new = self.manifest()
        self.publisher.stage(new, self.root)
        future = self.manifest("v1.5.8").read_bytes()

        def race(key):
            if key == release.LATEST:
                self.store.objects[key] = future

        self.store.before_put = race
        with self.assertRaisesRegex(release.PublishError, "concurrently"):
            self.publisher.activate(new)
        self.assertEqual(self.store.objects[release.LATEST], future)

    def test_official_release_gate_precedes_latest_write(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        self.publisher.release_check = release.require_github_release
        payload = json.loads(base64.b64decode(json.loads(manifest.read_text())["payload"]))
        for metadata in [
            {"draft": True},
            {"draft": False, "prerelease": False, "published_at": "now", "tag_name": payload["version"], "target_commitish": "wrong"},
            {"draft": False, "prerelease": False, "published_at": "now", "tag_name": payload["version"], "target_commitish": payload["commit"], "assets": []},
        ]:
            def response(command):
                return subprocess.CompletedProcess(command, 0, json.dumps(metadata) if command[0] == "gh" else "", "")
            self.verify_command.side_effect = response
            with self.assertRaises(release.PublishError):
                self.publisher.activate(manifest)
            self.assertNotIn(release.LATEST, self.store.objects)

    def test_github_latest_version_and_public_bytes_gate_activation(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        self.publisher.release_check = release.require_github_release
        payload = json.loads(base64.b64decode(json.loads(manifest.read_text())["payload"]))
        metadata = {"draft": False, "prerelease": False, "published_at": "now", "tag_name": payload["version"],
                    "target_commitish": payload["commit"], "assets": [{"name": name, "state": "uploaded"} for name in
                    ["desktop-update.json"] + [f"BeefTV-{payload['version']}-{platform}.zip" for platform in release.PLATFORMS]]}
        latest_tag = "v1.5.6"

        def response(command):
            if command[0] != "gh":
                return subprocess.CompletedProcess(command, 0, "", "")
            value = {"tag_name": latest_tag} if command[-1].endswith("/latest") else metadata
            return subprocess.CompletedProcess(command, 0, json.dumps(value), "")

        self.verify_command.side_effect = response
        key = urlsplit(release.GITHUB_LATEST_FEED).path.lstrip("/")
        self.store.objects[key] = manifest.read_bytes()
        writes = list(self.store.writes)
        with self.assertRaisesRegex(release.PublishError, "GitHub latest"):
            self.publisher.activate(manifest)
        self.assertEqual(self.store.writes, writes)
        latest_tag = payload["version"]
        self.store.objects[key] = b"x" * manifest.stat().st_size
        with self.assertRaisesRegex(release.PublishError, "hash"):
            self.publisher.activate(manifest)
        self.assertEqual(self.store.writes, writes)
        self.assertNotIn(release.LATEST, self.store.objects)
        self.store.objects[key] = manifest.read_bytes()
        self.publisher.activate(manifest)
        self.assertEqual(self.store.objects[release.LATEST], manifest.read_bytes())
        self.assertIn(("/" + key, "BeefTV-Desktop-Updater/v1.5.7"), self.public_requests)

    def recovery_documents(self, manifest):
        lock = json.dumps({"schema": 1, "nonce": "a" * 32, "target": release.LATEST,
                           "owner": {"GITHUB_REPOSITORY": "glanderness/BeefTV", "GITHUB_RUN_ID": "42",
                                     "GITHUB_RUN_ATTEMPT": "2", "GITHUB_JOB": "publish"}}).encode()
        claim = json.dumps({"schema": 1, "target": release.LATEST, "expectedETag": None,
                            "nextSize": manifest.stat().st_size,
                            "nextSHA256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
                            "publisher": json.loads(lock)}).encode()
        self.store.provider = "cos"

        def resumed(target, source, *documents):
            self.store.objects[target] = Path(source).read_bytes()

        self.store.resume = Mock(side_effect=resumed)
        self.recovery_confirmations = dict(confirm_no_inflight=True, confirm_writers_frozen=True, confirm_no_unlock_attempt=True)
        return lock, claim

    def test_resume_requires_explicit_inflight_confirmation_before_any_check_or_write(self):
        manifest = self.manifest()
        lock, claim = self.recovery_documents(manifest)
        cases = [("r2", self.recovery_confirmations)]
        cases += [("cos", dict(self.recovery_confirmations, **{flag: False})) for flag in self.recovery_confirmations]
        for provider, confirmations in cases:
            self.store.provider = provider
            with self.subTest(provider=provider), self.assertRaisesRegex(release.PublishError, "explicit confirmation"):
                self.publisher.resume(manifest, lock, claim, **confirmations)
        self.verify_command.assert_not_called()
        self.store.resume.assert_not_called()
        self.assertEqual(self.public_requests, [])

    def test_resume_keeps_signature_terminal_release_and_public_checks_before_mutation(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        lock, claim = self.recovery_documents(manifest)
        key = "beeftv/v1.5.7/BeefTV-v1.5.7-windows-amd64.zip"
        original = self.store.objects[key]
        with patch.object(release, "require_terminal_publisher") as terminal:
            self.verify_command.return_value = subprocess.CompletedProcess([], 1, "", "private diagnostic")
            with self.assertRaisesRegex(release.PublishError, "signature"):
                self.publisher.resume(manifest, lock, claim, **self.recovery_confirmations)
            terminal.assert_not_called()
            self.verify_command.return_value = subprocess.CompletedProcess([], 0, "", "")
            terminal.side_effect = release.PublishError("not terminal")
            with self.assertRaisesRegex(release.PublishError, "not terminal"):
                self.publisher.resume(manifest, lock, claim, **self.recovery_confirmations)
            terminal.side_effect = None
            self.publisher.release_check = Mock(side_effect=release.PublishError("release mismatch"))
            with self.assertRaisesRegex(release.PublishError, "release mismatch"):
                self.publisher.resume(manifest, lock, claim, **self.recovery_confirmations)
            self.publisher.release_check = Mock()
            self.store.objects[key] = b"x" * len(original)
            with self.assertRaisesRegex(release.PublishError, "hash"):
                self.publisher.resume(manifest, lock, claim, **self.recovery_confirmations)
        self.store.resume.assert_not_called()
        self.assertNotIn(release.LATEST, self.store.objects)

    def test_resume_passes_exact_original_documents_and_checks_public_latest(self):
        manifest = self.manifest()
        self.publisher.stage(manifest, self.root)
        lock, claim = self.recovery_documents(manifest)
        metadata = {"id": 42, "run_attempt": 2, "status": "completed", "repository": {"full_name": "glanderness/BeefTV"}}

        def response(command):
            return subprocess.CompletedProcess(command, 0, json.dumps(metadata) if command[0] == "gh" else "", "")

        self.verify_command.side_effect = response
        self.publisher.release_check = Mock()
        self.public_requests.clear()
        self.assertEqual(self.publisher.resume(manifest, lock, claim, **self.recovery_confirmations), "v1.5.7")
        self.store.resume.assert_called_once_with(release.LATEST, manifest, lock, claim)
        self.assertIn(["gh", "api", "repos/glanderness/BeefTV/actions/runs/42/attempts/2"],
                      [call.args[0] for call in self.verify_command.call_args_list])
        self.publisher.release_check.assert_called_once()
        self.assertEqual(self.public_requests[-1], ("/beeftv/desktop-update.json", "BeefTV-Desktop-Updater/v1.5.7"))


class TerminalPublisherTests(unittest.TestCase):
    def lock(self, owner=None):
        owner = owner if owner is not None else {"GITHUB_REPOSITORY": "glanderness/BeefTV", "GITHUB_RUN_ID": "42",
                                                "GITHUB_RUN_ATTEMPT": "2", "GITHUB_JOB": "publish"}
        return json.dumps({"owner": owner}).encode()

    def test_missing_or_unofficial_identity_never_calls_github(self):
        for owner in [{}, {"GITHUB_REPOSITORY": "another/repo", "GITHUB_RUN_ID": "42", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_JOB": "publish"},
                      {"GITHUB_REPOSITORY": "glanderness/BeefTV", "GITHUB_RUN_ID": "42/attempts/1", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_JOB": "publish"}]:
            with self.subTest(owner=owner), patch.object(release, "run") as runner, self.assertRaises(release.PublishError):
                release.require_terminal_publisher(self.lock(owner))
            runner.assert_not_called()

    def test_only_the_exact_completed_run_attempt_is_accepted(self):
        metadata = {"id": 42, "run_attempt": 2, "status": "completed", "repository": {"full_name": "glanderness/BeefTV"}}
        invalid = [dict(metadata, status="in_progress"), dict(metadata, id=43), dict(metadata, run_attempt=1),
                   dict(metadata, repository={"full_name": "another/repo"}), [], None]
        for value in invalid:
            with self.subTest(metadata=value), patch.object(release, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(value), "")):
                with self.assertRaises(release.PublishError):
                    release.require_terminal_publisher(self.lock())
        with patch.object(release, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(metadata), "")) as runner:
            release.require_terminal_publisher(self.lock())
            runner.assert_called_once_with(["gh", "api", "repos/glanderness/BeefTV/actions/runs/42/attempts/2"])
        for status, output in [(1, ""), (0, "not json")]:
            with patch.object(release, "run", return_value=subprocess.CompletedProcess([], status, output, "private diagnostic")):
                with self.assertRaises(release.PublishError):
                    release.require_terminal_publisher(self.lock())


class S3AdapterTests(unittest.TestCase):
    def test_cli_resume_snapshots_manifest_and_preserves_original_recovery_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, lock, claim = (root / name for name in ("manifest", "lock", "claim"))
            manifest.write_bytes(b"original signed envelope")
            lock.write_bytes(b'{ "original": "lock" }\n')
            claim.write_bytes(b'{ "original": "claim" }\n')
            args = ["publish", "resume", "--manifest", str(manifest), "--verifier", "/tmp/update-release",
                    "--provider", "cos",
                    "--endpoint-url", "https://cos.ap-guangzhou.myqcloud.com", "--lock-document", str(lock),
                    "--claim-document", str(claim), "--confirm-no-inflight-put", "--confirm-writers-frozen", "--confirm-no-unlock-attempt"]
            with patch.object(release.sys, "argv", args), patch.object(release, "storage_config") as factory, patch.object(release, "Publisher") as publisher, patch("builtins.print"):
                def resume(snapshot, lock_bytes, claim_bytes, **confirmations):
                    self.assertNotEqual(snapshot, manifest)
                    self.assertEqual(snapshot.read_bytes(), manifest.read_bytes())
                    self.assertEqual(lock_bytes, lock.read_bytes())
                    self.assertEqual(claim_bytes, claim.read_bytes())
                    self.assertEqual(confirmations, dict(confirm_no_inflight=True, confirm_writers_frozen=True,
                                                         confirm_no_unlock_attempt=True, installer_dir=None,
                                                         require_active_source=False))
                    return "v1.5.7"
                publisher.return_value.resume.side_effect = resume
                self.assertEqual(release.main(), 0)
                factory.return_value.check_conditions.assert_called_once()
                publisher.return_value.resume.assert_called_once()

    def test_cli_resume_requires_original_documents_and_confirmation_before_cloud_probe(self):
        base = ["publish", "resume", "--manifest", "/tmp/not-read", "--verifier", "/tmp/not-called",
                "--provider", "cos",
                "--endpoint-url", "https://cos.ap-guangzhou.myqcloud.com"]
        documents = ["--lock-document", "/tmp/lock", "--claim-document", "/tmp/claim"]
        confirmations = ["--confirm-no-inflight-put", "--confirm-writers-frozen", "--confirm-no-unlock-attempt"]
        invalid = [[], documents, documents[:2] + confirmations, ["--provider", "r2"] + documents + confirmations]
        invalid += [documents + [flag for flag in confirmations if flag != missing] for missing in confirmations]
        for flags in invalid:
            with self.subTest(flags=flags), patch.object(release.sys, "argv", base + flags), patch.object(release, "storage_config") as factory, redirect_stderr(io.StringIO()):
                self.assertEqual(release.main(), 1)
                factory.return_value.check_conditions.assert_not_called()

    def test_cos_credentials_are_restricted_to_matching_regional_service_and_public_bucket(self):
        bucket, region = "beeftv-components-1481187348", "ap-guangzhou"
        endpoint = f"https://cos.{region}.myqcloud.com"
        public = f"https://{bucket}.cos.{region}.myqcloud.com/beeftv"
        for changes in [{"endpoint": "https://cos.ap-guangzhou.myqcloud.com.evil.example"},
                        {"endpoint": endpoint + "/path"}, {"region": "auto"},
                        {"bucket": "without-appid"}, {"public_base": "https://evil.example/beeftv"}]:
            with self.subTest(changes=changes), self.assertRaises(release.PublishError), patch.object(release, "run") as runner:
                values = dict(provider="cos", endpoint=endpoint, region=region, bucket=bucket, public_base=public)
                values.update(changes)
                release.storage_config(**values)
                runner.assert_not_called()
        store = release.storage_config("cos", endpoint, region, bucket, public)
        self.assertEqual(store.http.host, f"{bucket}.cos.{region}.myqcloud.com")
        self.assertEqual(store.http.region, region)

    def test_bridge_cli_rejects_wrong_provider_installers_and_receipts_before_cloud_probe(self):
        base = ["publish", "bridge-cos", "--manifest", "/tmp/not-read", "--verifier", "/tmp/not-called"]
        cos = ["--provider", "cos", "--endpoint-url", "https://cos.ap-guangzhou.myqcloud.com"]
        invalid = [
            ["--endpoint-url", "https://" + "a" * 32 + ".r2.cloudflarestorage.com"],
            cos + ["--with-installers"],
            cos + ["--verification-receipt", "/tmp/not-read"],
        ]
        for flags in invalid:
            with self.subTest(flags=flags), patch.object(release.sys, "argv", base + flags), \
                    patch.object(release, "storage_config") as factory, redirect_stderr(io.StringIO()):
                self.assertEqual(release.main(), 1)
                factory.return_value.check_conditions.assert_not_called()

    def test_bridge_cli_uses_r2_assets_and_original_cos_feed(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "manifest"
            manifest.write_bytes(b"original signed envelope")
            args = ["publish", "bridge-cos", "--manifest", str(manifest), "--verifier", "/tmp/update-release",
                    "--provider", "cos", "--endpoint-url", "https://cos.ap-guangzhou.myqcloud.com"]
            with patch.object(release.sys, "argv", args), patch.object(release, "storage_config"), \
                    patch.object(release, "Publisher") as publisher, patch("builtins.print"):
                publisher.return_value.activate.return_value = "v1.5.7"
                self.assertEqual(release.main(), 0)
                self.assertEqual(publisher.call_args.args[3], release.R2_PUBLIC_BASE)
                self.assertEqual(publisher.call_args.kwargs['feed_public_base'], release.COS_PUBLIC_BASE)
                self.assertEqual(publisher.return_value.activate.call_args.kwargs, {'require_active_source': True})

    def test_bridge_resume_cli_preserves_recovery_documents_and_requires_r2_source(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest, lock, claim = (Path(directory) / name for name in ("manifest", "lock", "claim"))
            for path in (manifest, lock, claim):
                path.write_bytes(path.name.encode())
            args = ["publish", "resume-cos-bridge", "--manifest", str(manifest), "--verifier", "/tmp/update-release",
                    "--provider", "cos", "--endpoint-url", "https://cos.ap-guangzhou.myqcloud.com",
                    "--lock-document", str(lock), "--claim-document", str(claim),
                    "--confirm-no-inflight-put", "--confirm-writers-frozen", "--confirm-no-unlock-attempt"]
            with patch.object(release.sys, "argv", args), patch.object(release, "storage_config"), \
                    patch.object(release, "Publisher") as publisher, patch("builtins.print"):
                self.assertEqual(release.main(), 0)
                self.assertEqual(publisher.call_args.args[3], release.R2_PUBLIC_BASE)
                self.assertEqual(publisher.call_args.kwargs['feed_public_base'], release.COS_PUBLIC_BASE)
                self.assertEqual(publisher.return_value.resume.call_args.args[1:], (b"lock", b"claim"))
                self.assertTrue(publisher.return_value.resume.call_args.kwargs['require_active_source'])

    def test_legacy_r2_configuration_still_requires_account_endpoint_and_auto_region(self):
        store = release.storage_config("r2", "https://" + "a" * 32 + ".r2.cloudflarestorage.com",
                                       "auto", "beeftv-releases", "https://updates.beefapi.com/beeftv")
        self.assertEqual(store.provider, "r2")
        with self.assertRaises(release.PublishError):
            release.storage_config("r2", "https://" + "a" * 32 + ".r2.cloudflarestorage.com",
                                   "ap-guangzhou", "beeftv-releases", "https://updates.beefapi.com/beeftv")

    def test_cli_rejects_credential_destination_before_any_command(self):
        for endpoint in ["https://attacker.example", "https://" + "a" * 32 + ".r2.cloudflarestorage.com.evil.example", "https://user@" + "a" * 32 + ".r2.cloudflarestorage.com"]:
            with patch.object(release.sys, "argv", ["publish", "stage", "--manifest", "/tmp/not-read", "--verifier", "/tmp/not-called", "--endpoint-url", endpoint]), patch.object(release, "run") as runner, redirect_stderr(io.StringIO()):
                self.assertEqual(release.main(), 1)
                runner.assert_not_called()

    def test_put_uses_conditional_write_and_never_passes_credentials(self):
        with patch.object(release, "run", return_value=subprocess.CompletedProcess([], 0, "{}", "")) as runner:
            s3 = release.S3("https://example.r2.cloudflarestorage.com", "beeftv-releases")
            self.assertTrue(s3.put("beeftv/v1.5.7/file.zip", Path("/tmp/file"), release.IMMUTABLE))
            self.assertEqual(runner.call_args.args[0][-2:], ["--if-none-match", "*"])
            self.assertTrue(s3.put(release.LATEST, Path("/tmp/feed"), release.REVALIDATE, etag='"old"'))
            self.assertEqual(runner.call_args.args[0][-2:], ["--if-match", '"old"'])

    def test_permission_failure_is_not_treated_as_absent(self):
        with patch.object(release, "run", return_value=subprocess.CompletedProcess([], 1, "", "(AccessDenied) credential")):
            with self.assertRaisesRegex(release.PublishError, "Cannot inspect"):
                release.S3("https://r2.example", "beeftv-releases").get(release.LATEST, "/tmp/unused")


class ConditionalCapabilityTests(unittest.TestCase):
    def store(self, ignore_create=False, ignore_replace=False, ignore_stale=False):
        store = release.S3("https://r2.example", "beeftv-releases")
        fake = FakeS3()
        normal_put = fake.put
        writes = 0

        def put(key, source, cache_control, etag=None):
            nonlocal writes
            writes += 1
            if ((ignore_create and etag is None) or (ignore_replace and etag is not None)
                    or (ignore_stale and writes == 5)):
                fake.objects[key] = Path(source).read_bytes()
                return True
            return normal_put(key, source, cache_control, etag)

        store.put = put
        store.get = fake.get
        store.delete_probe = lambda key: fake.objects.pop(key, None)
        return store, fake

    def test_real_conditional_semantics_pass_and_probe_is_removed(self):
        store, fake = self.store()
        store.check_conditions()
        self.assertEqual(fake.objects, {})
        self.assertTrue(all(key.startswith("beeftv/.publication-probes/") for key, _ in fake.writes))

    def test_ignored_create_and_replacement_conditions_block_and_cleanup(self):
        for flags, error in [(dict(ignore_create=True), "If-None-Match"),
                             (dict(ignore_replace=True), "If-Match"),
                             (dict(ignore_stale=True), "stale")]:
            with self.subTest(flags=flags):
                store, fake = self.store(**flags)
                with self.assertRaisesRegex(release.PublishError, error):
                    store.check_conditions()
                self.assertEqual(fake.objects, {})

    def test_probe_cleanup_cannot_delete_release_assets(self):
        with patch.object(release, "run") as runner, self.assertRaises(release.PublishError):
            release.S3("https://unused", "unused").delete_probe(release.LATEST)
        runner.assert_not_called()

    def test_cleanup_failure_preserves_original_condition_failure(self):
        store, _ = self.store(ignore_create=True)
        store.delete_probe = lambda _: (_ for _ in ()).throw(release.PublishError("cleanup"))
        with self.assertRaisesRegex(release.PublishError, "If-None-Match.*cleanup also failed"):
            store.check_conditions()


if __name__ == "__main__":
    unittest.main()
