#!/usr/bin/env python3
"""CI-only native installer lifecycle with a real desktop-created database."""
import argparse
import errno
from contextlib import closing, ExitStack
import hashlib
import json
import os
from pathlib import Path
import shutil
import secrets
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def cleanup_process(process):
    if process.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(process.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def launch(exe, env, data, log_path, cleanup):
    token = secrets.token_hex(24)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(env, CANVAS_DESKTOP_BACKEND_ADDR=f'127.0.0.1:{port}', CANVAS_DESKTOP_LAUNCH_TOKEN=token)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with log_path.open('w') as log:
        process = subprocess.Popen([str(exe)], env=env, stdout=log, stderr=log)
    cleanup.callback(cleanup_process, process)
    try:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                request = urllib.request.Request(f'http://127.0.0.1:{port}/api/health/ready', headers={'X-Desktop-Token': token})
                with opener.open(request, timeout=2) as response:
                    result = json.load(response)
                    if result.get('code') == 0 and result.get('data', {}).get('ready') is True and (data / 'open_ai_canvas.db').is_file():
                        if os.name == 'nt':
                            process.webview_profile = Path(env['APPDATA']) / 'BeefTV.exe'
                            deadline_webview = time.monotonic() + 45
                            while not webview_profile_running(process.webview_profile, process.pid):
                                if time.monotonic() >= deadline_webview:
                                    raise RuntimeError('Production WebView did not open the expected profile')
                                time.sleep(.5)
                        return process
            except (OSError, ValueError):
                pass
            if process.poll() is not None:
                raise RuntimeError('desktop exited: ' + log_path.read_text(errors='replace')[-3000:])
            time.sleep(.5)
        raise RuntimeError('installed desktop backend did not start')
    except BaseException:
        stop(process)
        raise


def webview_profile_running(profile, parent=None):
    profile = str(profile).replace("'", "''")
    condition = f"$_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and $_.CommandLine.Contains('{profile}')"
    if parent is not None:
        condition += f' -and $_.ParentProcessId -eq {parent}'
    result = subprocess.run(['powershell', '-NoProfile', '-Command',
                             f"$ErrorActionPreference='Stop'; try {{ if (@(Get-CimInstance Win32_Process | Where-Object {{ {condition} }}).Count -gt 0) {{ exit 0 }} else {{ exit 1 }} }} catch {{ exit 3 }}"],
                            check=False, timeout=30)
    if result.returncode not in (0, 1):
        raise RuntimeError('Cannot inspect the actual WebView profile')
    return result.returncode == 0


def stop(process):
    if os.name == 'nt' and process.poll() is None:
        subprocess.run(['powershell', '-NoProfile', '-Command', f'$p=Get-Process -Id {process.pid} -ErrorAction SilentlyContinue; if ($p) {{ $p.CloseMainWindow() | Out-Null }}'], check=True)
    else:
        process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)
    if hasattr(process, 'webview_profile'):
        deadline = time.monotonic() + 30
        while webview_profile_running(process.webview_profile):
            if time.monotonic() >= deadline:
                raise RuntimeError('Old production WebView profile is still open')
            time.sleep(.5)
    if hasattr(process, 'webview_port'):
        deadline = time.monotonic() + 30
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        last_result = 'no inspection'
        while time.monotonic() < deadline:
            try:
                # Winsock can take more than one second to report refusal even
                # on localhost. A timeout is never evidence that it is closed.
                opener.open(f'http://127.0.0.1:{process.webview_port}/json/list', timeout=5).close()
                last_result = 'debug endpoint still responds'
            except OSError as error:
                last_result = repr(error)
                reason = getattr(error, 'reason', error)
                if isinstance(reason, OSError) and (reason.errno in (errno.ECONNREFUSED, 10061) or getattr(reason, 'winerror', None) == 10061):
                    return
            time.sleep(.5)
        raise RuntimeError('Old WebView remained running; cannot verify a fresh profile startup: ' + last_result)


def probe_cache(helper, profile, operation, env, root, cleanup):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    with (root / f'cache-{operation}.log').open('w') as log:
        process = subprocess.Popen([str(helper), str(profile), str(port)], env=env, stdout=log, stderr=log)
    cleanup.callback(cleanup_process, process)
    process.webview_port = port
    process.webview_profile = profile
    try:
        subprocess.run(['node', str(Path(__file__).with_name('smoke-webview-cache.mjs')), str(port), operation], check=True, timeout=90)
    except BaseException:
        print((root / f'cache-{operation}.log').read_text(errors='replace')[-3000:])
        try:
            stop(process)
        except Exception as error:
            print('Probe cleanup failed:', error)
            cleanup_process(process)
        raise
    else:
        stop(process)


def build_cache_probe(helper):
    subprocess.run(['go', 'build', '-ldflags=-H=windowsgui', '-o', str(helper), str(Path(__file__).with_name('webview-cache-probe_windows.go').resolve())],
                   cwd=Path(__file__).resolve().parent.parent / 'backend', check=True, timeout=180)


def probe_self_test():
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.name != 'nt':
        raise RuntimeError('WebView probe self-test requires a disposable Windows CI runner')
    with tempfile.TemporaryDirectory(prefix='beeftv-probe-') as directory, ExitStack() as cleanup:
        root = Path(directory)
        helper = root / 'webview-cache-probe.exe'
        build_cache_probe(helper)
        for operation in ['write', 'read']:
            probe_cache(helper, root / 'profile', operation, dict(os.environ), root, cleanup)
        print('PASS: isolated WebView probe writes, closes fully, reopens and reads committed IndexedDB')
        # Exercise the real NSIS failure branch with a tiny payload before the
        # expensive desktop build. This fixture is never a published artifact.
        installed = Path(os.environ['LOCALAPPDATA']) / 'Programs/BeefTV'
        if installed.exists():
            raise RuntimeError('Unexpected existing app on disposable CI runner')
        payload = root / 'fixture-payload'
        payload.mkdir()
        (payload / 'BeefTV.exe').write_bytes(b'installer fixture payload')
        version = (Path(__file__).resolve().parent.parent / 'VERSION').read_text().strip()
        installer = root / 'fixture-output' / f'BeefTV-{version}-windows-amd64-setup.exe'
        subprocess.run(['python', str(Path(__file__).with_name('package-desktop-installer.py')), '--platform', 'windows-amd64',
                        '--input', str(payload), '--output-dir', str(installer.parent)], check=True, timeout=90)
        try:
            subprocess.run([str(installer), '/S'], check=True, timeout=90)
            (installed / 'BeefTV.exe').write_bytes(b'previous app must survive failed replacement')
            locked_windows_upgrade(installer, installed)
            concurrent_windows_install(installer, installed)
            locked_windows_upgrade(installer, installed, release_after_failure=True)
            assert (installed / 'BeefTV.exe').read_bytes() == b'installer fixture payload'
        finally:
            if (installed / 'Uninstall.exe').is_file():
                subprocess.run([str(installed / 'Uninstall.exe'), '/S'], check=True, timeout=90)
                deadline = time.monotonic() + 90
                while installed.exists() and time.monotonic() < deadline:
                    time.sleep(.5)
                assert not installed.exists(), 'fixture uninstall did not finish'
        print('PASS: native NSIS rejects a proven directory lock and preserves different previous bytes')


def windows_custom_install_dir(installer, root):
    import winreg
    key = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV'
    custom = root / 'Custom'
    installed = custom / 'BeefTV'

    def install_location():
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
            return winreg.QueryValueEx(handle, 'InstallLocation')[0]

    def run(*args):
        # NSIS /D= must be the last, unquoted parameter even when the path has spaces.
        return subprocess.run(f'"{installer}" ' + ' '.join(args), timeout=180)

    result = run('/S', '/D=' + str(custom))
    assert result.returncode == 0, f'chosen-location install failed with {result.returncode}'
    assert (installed / 'BeefTV.exe').is_file()
    assert (installed / '.installed-root-files.txt').is_file()
    assert install_location() == str(installed), install_location()

    # An upgrade without /D must reuse the registered location.
    result = run('/S')
    assert result.returncode == 0, f'upgrade without /D failed with {result.returncode}'
    assert (installed / 'BeefTV.exe').is_file()
    assert install_location() == str(installed), install_location()

    # Choosing a folder that already holds other files installs into its own
    # BeefTV subfolder and leaves those files alone.
    apps = root / 'Apps'
    apps.mkdir()
    (apps / 'other.txt').write_bytes(b'other app')
    result = run('/S', '/D=' + str(apps))
    assert result.returncode == 0, f'install under a shared folder failed with {result.returncode}'
    assert (apps / 'BeefTV' / 'BeefTV.exe').is_file()
    assert (apps / 'other.txt').read_bytes() == b'other app'
    assert install_location() == str(apps / 'BeefTV'), install_location()
    assert not (installed / 'BeefTV.exe').exists(), 'moving the install left the old executable behind'
    assert not (installed / 'Uninstall.exe').exists(), 'moving the install left a stale uninstaller behind'
    subprocess.run([str(apps / 'BeefTV' / 'Uninstall.exe'), '/S'], check=True, timeout=90)
    deadline = time.monotonic() + 90
    while (apps / 'BeefTV').exists() and time.monotonic() < deadline:
        time.sleep(.5)
    assert not (apps / 'BeefTV').exists(), 'uninstall under a shared folder left files behind'
    assert (apps / 'other.txt').read_bytes() == b'other app'
    result = run('/S', '/D=' + str(custom))
    assert result.returncode == 0, f'reinstall into the chosen folder failed with {result.returncode}'

    # A portable BeefTV folder (with BeefTV.exe but no installer manifest yet)
    # can be upgraded in place while keeping unknown user files inside it.
    portable_dir = root / 'PortableUpgrade' / 'BeefTV'
    portable_dir.mkdir(parents=True)
    (portable_dir / 'BeefTV.exe').write_bytes(b'old portable exe')
    (portable_dir / 'user-note.txt').write_bytes(b'keep user note')
    result = run('/S', '/D=' + str(portable_dir))
    assert result.returncode == 0, f'portable folder upgrade failed with {result.returncode}'
    assert (portable_dir / '.installed-root-files.txt').is_file()
    assert (portable_dir / 'user-note.txt').read_bytes() == b'keep user note'
    assert install_location() == str(portable_dir), install_location()
    result = run('/S', '/D=' + str(custom))
    assert result.returncode == 0, f'reinstall into the chosen folder failed with {result.returncode}'
    assert not (portable_dir / 'BeefTV.exe').exists(), 'moving from portable upgrade left old executable behind'
    assert (portable_dir / 'user-note.txt').read_bytes() == b'keep user note'

    # A non-empty BeefTV folder that is not a BeefTV install must be refused
    # without touching its files.
    foreign = root / 'Foreign' / 'BeefTV'
    foreign.mkdir(parents=True)
    (foreign / 'keep.txt').write_bytes(b'keep foreign file')
    result = run('/S', '/D=' + str(foreign))
    assert result.returncode != 0, 'installer accepted a non-empty foreign folder'
    assert sorted(p.name for p in foreign.iterdir()) == ['keep.txt']
    assert (foreign / 'keep.txt').read_bytes() == b'keep foreign file'
    assert install_location() == str(installed), 'refused install changed the registered location'

    subprocess.run([str(installed / 'Uninstall.exe'), '/S'], check=True, timeout=90)
    deadline = time.monotonic() + 90
    while installed.exists() and time.monotonic() < deadline:
        time.sleep(.5)
    assert not installed.exists(), 'chosen-location uninstall left files behind'
    try:
        install_location()
    except FileNotFoundError:
        pass
    else:
        raise AssertionError('uninstall left the BeefTV registry key')
    print('PASS: chosen install folder, upgrade reuse, portable upgrade, foreign-folder refusal and custom uninstall')


def verify_data(data):
    with closing(sqlite3.connect(data / 'open_ai_canvas.db')) as db:
        assert db.execute("SELECT name,revision FROM projects WHERE id='installer-project'").fetchone() == ('Keep my project', 7)
        assert db.execute("SELECT value_json FROM system_settings WHERE key='installer-setting'").fetchone() == ('{"preserve":true}',)
    for name in ['assets/original.png', 'drafts/unsaved.json']:
        assert (data / name).read_bytes() == b'preserve installer data'


def concurrent_windows_install(installer, installed):
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateMutexW(None, False, r'Local\BeefTV.Installation')
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    before = digest(installed / 'BeefTV.exe')
    try:
        result = subprocess.run([str(installer), '/S'], timeout=60)
        assert result.returncode == 2, 'a second installer bypassed installation mutex'
        result = subprocess.run([str(installed / 'Uninstall.exe'), '/S', '_?=' + str(installed)], timeout=60)
        assert result.returncode == 2, 'uninstaller bypassed installation mutex'
        assert digest(installed / 'BeefTV.exe') == before
    finally:
        kernel.CloseHandle(handle)
    print('PASS: installer and uninstaller refuse concurrent changes')


def locked_windows_upgrade(installer, installed, release_after_failure=False):
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    # A read handle denying FILE_SHARE_DELETE must prevent a directory rename.
    handle = kernel.CreateFileW(str(installed), 0x80000000, 3, None, 3, 0x02000000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    before = {str(path.relative_to(installed)): digest(path) for path in installed.rglob('*') if path.is_file()}
    logs = Path(os.environ['LOCALAPPDATA']) / 'BeefTV/Installer'
    previous_logs = set(logs.glob('*.log'))
    process = None
    try:
        # Prove the fixture denies a real rename before judging the installer.
        control = installed.with_name(installed.name + '-rename-control')
        try:
            installed.rename(control)
        except OSError as error:
            assert getattr(error, 'winerror', None) in (5, 32), repr(error)
        else:
            control.rename(installed)
            raise RuntimeError('Directory lock fixture did not prevent rename')
        process = subprocess.Popen([str(installer), '/S'])
        if release_after_failure:
            # Release only after the real installer has logged a denied move.
            # This proves its retry, rather than relying on an arbitrary sleep.
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                current = set(logs.glob('*.log')) - previous_logs
                if any('backup: error=' in p.read_text(errors='replace') for p in current):
                    kernel.CloseHandle(handle)
                    handle = None
                    break
                if process.poll() is not None:
                    raise RuntimeError('Installer exited before reporting the held directory lock')
                time.sleep(.05)
            else:
                raise RuntimeError('Installer did not report the held directory lock')
        expected = 0 if release_after_failure else 1
        result = process.wait(timeout=180)
        assert result == expected, f'locked application directory: expected code {expected}, got {result}'
        current = set(logs.glob('*.log')) - previous_logs
        assert len(current) == 1, 'expected a persistent log for this installation'
        log = current.pop().read_text(errors='replace')
        assert 'backup: error=5 ' in log or 'backup: error=32 ' in log, log
        assert str(installed) in log, log
        if release_after_failure:
            assert 'activate: moved ' in log and 'registered: installed=' in log, log
    finally:
        if handle:
            kernel.CloseHandle(handle)
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=30)
    after = {str(path.relative_to(installed)): digest(path) for path in installed.rglob('*') if path.is_file()}
    if not release_after_failure:
        assert before == after, 'failed installer changed the previous application'


def smoke(args):
    # Never install into or uninstall from a developer's real machine.
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('Native installer lifecycle is restricted to disposable GitHub runners')
    installer = args.installer.resolve()
    payload = args.payload.resolve()
    with tempfile.TemporaryDirectory(prefix='beeftv-installer-') as directory, ExitStack() as cleanup:
        root = Path(directory)
        env = {k: v for k, v in os.environ.items() if not k.startswith(('CANVAS_', 'BEEFTV_'))}
        home = root / 'home'
        home.mkdir()
        env['HOME'] = str(home)
        env['LIBGL_ALWAYS_SOFTWARE'] = '1'
        if args.platform == 'windows-amd64':
            env['APPDATA'] = str(home / 'AppData/Roaming')
            data = Path(env['APPDATA']) / 'BeefTV'
            installed = Path(os.environ['LOCALAPPDATA']) / 'Programs/BeefTV'
            relative_exe = Path('BeefTV.exe')
            profile = Path(env['APPDATA']) / 'BeefTV.exe'
            helper = root / 'webview-cache-probe.exe'
            build_cache_probe(helper)
            windows_custom_install_dir(installer, root)
            def install():
                subprocess.run([str(installer), '/S'], check=True, timeout=180)
                import winreg
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV') as key:
                    assert winreg.QueryValueEx(key, 'InstallLocation')[0] == str(installed)
                menu = Path(os.environ['APPDATA']) / 'Microsoft/Windows/Start Menu/Programs/BeefTV'
                assert (menu / 'BeefTV.lnk').is_file()
                assert (menu / 'Uninstall.lnk').is_file()
                desktop = Path(os.environ['USERPROFILE']) / 'Desktop/BeefTV.lnk'
                assert desktop.is_file()
            def uninstall():
                # Normal NSIS uninstall runs a temporary copy so it can delete itself.
                subprocess.run([str(installed / 'Uninstall.exe'), '/S'], check=True, timeout=90)
                deadline = time.monotonic() + 90
                while installed.exists() and time.monotonic() < deadline:
                    time.sleep(.5)
                assert not installed.exists(), 'uninstall left shipped files or runtime directories'
        elif args.platform.startswith('darwin-'):
            data = home / 'Library/Application Support/BeefTV'
            installed = root / 'Applications/BeefTV.app'
            relative_exe = Path('Contents/MacOS/BeefTV')
            def install():
                mount = root / 'mounted'
                subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', str(mount), str(installer)], check=True)
                try:
                    assert (mount / 'Applications').is_symlink()
                    assert os.readlink(mount / 'Applications') == '/Applications'
                    if installed.exists():
                        shutil.rmtree(installed)
                    subprocess.run(['ditto', str(mount / 'BeefTV.app'), str(installed)], check=True)
                    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(installed)], check=True)
                finally:
                    subprocess.run(['hdiutil', 'detach', str(mount)], check=True)
            def uninstall():
                shutil.rmtree(installed)
        else:
            env['XDG_CONFIG_HOME'] = str(home / '.config')
            data = home / '.config/BeefTV'
            installed = Path('/opt/beeftv/BeefTV-linux')
            relative_exe = Path('BeefTV')
            def install():
                subprocess.run(['sudo', 'apt-get', 'install', '-y', '--reinstall', str(installer)], check=True, timeout=240)
                assert (installed / '.package-managed').read_text() == 'deb\n'
                assert Path('/usr/bin/beeftv').resolve() == installed / 'cli/beeftv'
                assert Path('/usr/share/applications/beeftv.desktop').is_file()
            def uninstall():
                subprocess.run(['sudo', 'dpkg', '--remove', 'beeftv'], check=True)
                assert not (installed / relative_exe).exists()

        portable = root / ('BeefTV.app' if args.platform.startswith('darwin-') else 'portable')
        shutil.copytree(payload, portable, symlinks=True)
        process = launch(portable / relative_exe, env, data, root / 'portable.log', cleanup)
        stop(process)
        if args.platform == 'windows-amd64':
            probe_cache(helper, profile, 'write', env, root, cleanup)
        with closing(sqlite3.connect(data / 'open_ai_canvas.db')) as db, db:
            db.execute("INSERT INTO projects (id,user_id,name,description,status,revision) VALUES ('installer-project','installer-user','Keep my project','Migration acceptance','draft',7)")
            db.execute("INSERT INTO system_settings (key,value_json) VALUES ('installer-setting','{\"preserve\":true}')")
        for name in ['assets/original.png', 'drafts/unsaved.json']:
            path = data / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'preserve installer data')
        # Existing WebView draft storage must also survive installer operations.
        cache = Path(env.get('APPDATA', str(home))) / 'BeefTV.exe/cache-sentinel'
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(b'keep webview cache')
        install()
        shutil.rmtree(portable)
        for iteration in range(2):
            for source in payload.rglob('*'):
                if source.is_file() and not source.is_symlink():
                    assert digest(source) == digest(installed / source.relative_to(payload)), str(source)
            process = launch(installed / relative_exe, env, data, root / f'installed-{iteration}.log', cleanup)
            if iteration == 0 and args.platform == 'windows-amd64':
                # Installing while BeefTV is open must automatically close the
                # running instance and complete the upgrade cleanly.
                install()
                process.wait(timeout=30)
            stop(process)
            if args.platform == 'windows-amd64':
                probe_cache(helper, profile, 'read', env, root, cleanup)
            verify_data(data)
            assert cache.read_bytes() == b'keep webview cache'
            if iteration == 0:
                if args.platform == 'windows-amd64':
                    locked_windows_upgrade(installer, installed)
                else:
                    install()
        uninstall()
        verify_data(data)
        assert cache.read_bytes() == b'keep webview cache'
        install()
        process = launch(installed / relative_exe, env, data, root / 'reinstalled.log', cleanup)
        stop(process)
        if args.platform == 'windows-amd64':
            probe_cache(helper, profile, 'read', env, root, cleanup)
        verify_data(data)
        uninstall()
        verify_data(data)
        print('PASS: portable migration, native installed startup, full payload, overwrite, uninstall and reinstall preserve project rows, settings, files and draft sentinels; no paid generation')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe-only', action='store_true', help='Check the Windows CI probe before the full desktop build')
    parser.add_argument('--platform')
    parser.add_argument('--installer', type=Path)
    parser.add_argument('--payload', type=Path)
    args = parser.parse_args()
    if args.probe_only:
        probe_self_test()
    else:
        if not all([args.platform, args.installer, args.payload]):
            parser.error('native lifecycle requires --platform, --installer and --payload')
        smoke(args)
