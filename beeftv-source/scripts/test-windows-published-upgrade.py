"""Exercise released Windows updater helpers against a final candidate archive.

No product model calls. Uses disposable installs and SQLite data. An actual old
EXE owns replacement; a healthy new backend and preserved data are required.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def download_fixture(fixture, directory):
    version = fixture['version']
    archive = directory / (version + '.zip')
    url = f'https://github.com/glanderness/BeefTV/releases/download/{version}/BeefTV-{version}-windows-amd64.zip'
    subprocess.run(['curl.exe', '-fLsS', '--retry', '2', '--max-time', '180', url, '-o', str(archive)], check=True)
    if digest(archive) != fixture['sha256']:
        raise RuntimeError('Published fixture hash mismatch: ' + version)
    unpacked = directory / version
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(unpacked)
    return unpacked


def wait_until(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.2)
    raise TimeoutError('Timed out waiting for native updater state')


def stop_installed(executable):
    # Include orphaned bundled Node processes, but never kill by image name.
    root = os.path.normcase(str(executable.parent.resolve())) + os.sep
    def owned():
        result = subprocess.run(['powershell', '-NoProfile', '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress'],
            capture_output=True, text=True, check=True)
        rows = json.loads(result.stdout or '[]')
        rows = rows if isinstance(rows, list) else [rows]
        return [row['ProcessId'] for row in rows if row.get('ExecutablePath') and
                os.path.normcase(os.path.realpath(row['ExecutablePath'])).startswith(root)]
    for pid in owned():
        # A child may already have exited with its parent; the final query is authority.
        subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True)
    wait_until(lambda: not owned(), 15)


def install_tree(root):
    result = {}
    for name in ['BeefTV.exe', 'cli', 'agent-host', 'plugin-packages', 'media-runtime']:
        path = root/name
        paths = [path] if path.is_file() else sorted(path.rglob('*')) if path.is_dir() else []
        for item in paths:
            if item.is_file():
                result[item.relative_to(root).as_posix()] = digest(item)
    return result


def wait_ready(port, token, version):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    consecutive = 0
    def ready():
        nonlocal consecutive
        request = urllib.request.Request(f'http://127.0.0.1:{port}/api/health/ready', headers={'X-Desktop-Token':token})
        try:
            with opener.open(request, timeout=2) as response:
                health = json.loads(response.read())
                data = health.get('data', {})
                ok = response.status == 200 and health.get('code') == 0 and data.get('ready') is True and data.get('build', {}).get('version') == version
                consecutive = consecutive + 1 if ok else 0
                return consecutive >= 2
        except (OSError, ValueError):
            consecutive = 0
            return False
    wait_until(ready, 60)


def verify_product_rows(db):
    with closing(sqlite3.connect(db)) as connection:
        project = connection.execute("SELECT name, description, revision FROM projects WHERE id='upgrade-audit-project'").fetchone()
        setting = connection.execute("SELECT value_json FROM system_settings WHERE key='upgrade-audit-setting'").fetchone()
    if project != ('Upgrade acceptance project', 'Keep this project', 7) or setting != ('{"preserve":true}',):
        raise RuntimeError('Existing product rows changed during upgrade or rollback')


def exercise(source, candidate, version, directory, rollback=False):
    install, staged, data = directory/'install', directory/'payload', directory/'data'
    shutil.copytree(source, install)
    shutil.copytree(candidate, staged)
    if rollback:
        # Structurally valid archive, but CreateProcess must reject its program.
        (staged/'BeefTV.exe').write_bytes(b'not a Windows executable')
    data.mkdir()
    db = data/'open_ai_canvas.db'
    helper = directory/'BeefTV-update-helper.exe'
    shutil.copy2(install/'BeefTV.exe', helper)
    token = secrets.token_hex(32)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    env = dict(os.environ, CANVAS_DESKTOP_DATA_DIR=str(data),
               CANVAS_DESKTOP_BACKEND_ADDR=f'127.0.0.1:{port}',
               CANVAS_DESKTOP_LAUNCH_TOKEN=token)
    parent = subprocess.Popen([str(install/'BeefTV.exe')], env=env)
    request = directory/'request.json'
    request.write_text(json.dumps(dict(schema=1, parentPid=parent.pid, platform='windows-amd64',
        targetPath=str(install/'BeefTV.exe'), stagedPath=str(staged), backupPath=str(directory/'backup'),
        preparedPath=str(directory/'prepared'), resultPath=str(directory/'result.json'), waitTimeoutSec=180)), encoding='utf-8')
    process = None
    try:
        # Let the actual old application create its schema, then add product data.
        wait_ready(port, token, source.name)
        with closing(sqlite3.connect(db)) as connection, connection:
            connection.execute("INSERT INTO projects (id,user_id,name,description,status,revision) VALUES (?,?,?,?,?,?)", ('upgrade-audit-project','upgrade-audit','Upgrade acceptance project','Keep this project','draft',7))
            connection.execute('INSERT INTO system_settings (key,value_json) VALUES (?,?)', ('upgrade-audit-setting','{"preserve":true}'))
        source_tree = install_tree(source)
        candidate_tree = install_tree(candidate)
        process = subprocess.Popen([str(helper), '--beeftv-update-helper', str(request)], env=env)
        wait_until(lambda: (directory/'prepared').exists() or process.poll() is not None, 30)
        if not (directory/'prepared').exists():
            raise RuntimeError((directory/'result.json').read_text(encoding='utf-8'))
        close = '$p=Get-Process -Id '+str(parent.pid)+'; for($i=0;$i -lt 100;$i++){ $p.Refresh(); if($p.MainWindowHandle -ne 0){break}; Start-Sleep -Milliseconds 200 }; if(-not $p.CloseMainWindow()){throw "Old desktop did not accept close"}'
        subprocess.run(['powershell', '-NoProfile', '-Command', close], check=True)
        parent.wait(timeout=90)
        process.wait(timeout=120)
        result = json.loads((directory/'result.json').read_text(encoding='utf-8'))
        if rollback:
            if result.get('status') != 'rolled_back' or not result.get('restored'):
                raise RuntimeError('Failed update did not restore the old install: ' + json.dumps(result))
            if install_tree(install) != source_tree:
                raise RuntimeError('Rollback did not restore the complete original file tree')
            wait_ready(port, token, source.name)
            verify_product_rows(db)
            return dict(rollback=True, oldInstallRestored=True, oldBackendReady=True, productRowsPreserved=True)
        if process.returncode or result.get('status') != 'launched' or not result.get('parentExited'):
            raise RuntimeError(json.dumps(result))
        if install_tree(install) != candidate_tree:
            raise RuntimeError('Installed payload differs from the complete candidate file tree')
        wait_ready(port, token, version)
        verify_product_rows(db)
        identity = hashlib.sha256(os.path.normpath(str(data)).lower().encode()).hexdigest()
        runtime_path = Path(os.environ['USERPROFILE'])/'.beeftv'/'runtime'/(identity+'.json')
        runtime = json.loads(runtime_path.read_text(encoding='utf-8'))
        if runtime['version'] != version or runtime['baseUrl'] != f'http://127.0.0.1:{port}/api':
            raise RuntimeError('Wrong application version started')
        return dict(replaced=True, backendReady=True, productRowsPreserved=True, completeFileTree=True, version=version,
                    boundary='actual old desktop shutdown and helper replacement; backend and product rows; no canvas UI or paid-generation acceptance')
    finally:
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        primary_error = sys.exc_info()[1]
        try:
            stop_installed(install/'BeefTV.exe')
            parent.wait(timeout=10)
        except Exception as cleanup_error:
            if primary_error is not None:
                primary_error.add_note('Process cleanup also failed: ' + str(cleanup_error))
            else:
                raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if sys.platform != 'win32':
        parser.error('This gate requires native Windows')
    fixtures = json.loads(Path(__file__).with_name('windows-upgrade-fixtures.json').read_text())
    receipts = []
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='BeefTV-upgrade-') as temporary:
        # Windows TEMP can contain an 8.3 alias; CIM reports full executable paths.
        root = Path(temporary).resolve()
        candidate = root/'candidate'
        with zipfile.ZipFile(args.archive) as bundle:
            bundle.extractall(candidate)
        for fixture in fixtures['currentLayout']:
            source = download_fixture(fixture, root)
            case = root/('case-'+fixture['version'])
            case.mkdir()
            try:
                result = exercise(source, candidate, args.version, case)
                receipts.append(dict(source=fixture['version'], **result))
                rollback_case = root/('rollback-'+fixture['version'])
                rollback_case.mkdir()
                result = exercise(source, candidate, args.version, rollback_case, rollback=True)
                receipts.append(dict(source=fixture['version'], **result))
            except Exception as error:
                receipts.append(dict(source=fixture['version'], passed=False, error=str(error)))
                raise
            finally:
                args.output.write_text(json.dumps(receipts, ensure_ascii=False, indent=2), encoding='utf-8')
            print(f"PASS {fixture['version']} -> {args.version}: full replacement, product rows, new backend and healthy rollback", flush=True)


if __name__ == '__main__':
    main()
