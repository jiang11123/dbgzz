#!/usr/bin/env python3
"""Wrap the existing release payload; updater ZIPs remain unchanged."""
import argparse
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SUFFIXES = {'darwin-arm64': '.dmg', 'darwin-amd64': '.dmg',
            'windows-amd64': '-setup.exe', 'linux-amd64': '.deb'}


def installer_name(version, platform):
    return f'BeefTV-{version}-{platform}{SUFFIXES[platform]}'


def package(version, platform, payload, output):
    if not re.fullmatch(r'v\d+\.\d+\.\d+', version):
        raise ValueError('Installers require a stable repository version')
    payload, output = payload.resolve(), output.resolve()
    exe = payload / ('Contents/MacOS/BeefTV' if platform.startswith('darwin-') else 'BeefTV.exe' if platform == 'windows-amd64' else 'BeefTV')
    if not exe.is_file():
        raise ValueError('Release payload executable is missing')
    output.parent.mkdir(parents=True, exist_ok=True)
    if platform.startswith('darwin-'):
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(payload)], check=True)
        with tempfile.TemporaryDirectory(prefix='beeftv-dmg-') as directory:
            stage = Path(directory) / 'image'
            stage.mkdir()
            subprocess.run(['ditto', str(payload), str(stage / 'BeefTV.app')], check=True)
            (stage / 'Applications').symlink_to('/Applications')
            shutil.copy2(ROOT / 'docs/desktop-install.md', stage / 'Installation.txt')
            subprocess.run(['hdiutil', 'create', '-volname', 'BeefTV', '-srcfolder', str(stage),
                            '-fs', 'HFS+', '-nospotlight', '-format', 'UDZO', '-verbose', '-ov', str(output)], check=True)
    elif platform == 'windows-amd64':
        compiler = shutil.which('makensis') or r'C:\Program Files (x86)\NSIS\makensis.exe'
        with tempfile.TemporaryDirectory(prefix='beeftv-nsis-') as directory:
            manifest = Path(directory) / 'installed-root-files.txt'
            manifest.write_text(''.join(path.name + '\n' for path in sorted(payload.iterdir()) if path.is_file()), encoding='utf-8')
            subprocess.run([compiler, '-INPUTCHARSET', 'UTF8', f'-DPAYLOAD={payload}', f'-DOUTPUT={output}',
                            f'-DROOTFILES={manifest}', f'-DVERSION={version[1:]}',
                            str(ROOT / 'scripts/installers/windows.nsi')], check=True)
    else:
        with tempfile.TemporaryDirectory(prefix='beeftv-deb-') as directory:
            stage = Path(directory)
            bundle = stage / 'opt/beeftv/BeefTV-linux'
            shutil.copytree(payload, bundle, symlinks=True)
            (bundle / '.package-managed').write_text('deb\n')
            control = stage / 'DEBIAN'
            control.mkdir()
            (control / 'control').write_text(
                f'Package: beeftv\nVersion: {version[1:]}\nArchitecture: amd64\n'
                'Maintainer: BeefTV Contributors <58928515+glanderness@users.noreply.github.com>\n'
                'Homepage: https://github.com/glanderness/BeefTV\nSection: graphics\nPriority: optional\n'
                'Depends: libgtk-3-0t64, libwebkit2gtk-4.1-0, gstreamer1.0-plugins-good, '
                'gstreamer1.0-plugins-bad, gstreamer1.0-libav, ffmpeg, fonts-noto-cjk\n'
                'Description: BeefTV creative workspace (Ubuntu 24.04)\n')
            applications = stage / 'usr/share/applications'
            applications.mkdir(parents=True)
            (applications / 'beeftv.desktop').write_text(
                '[Desktop Entry]\nType=Application\nName=BeefTV\n'
                'Exec=/opt/beeftv/BeefTV-linux/BeefTV %u\nIcon=beeftv\nMimeType=x-scheme-handler/beeftv;\n'
                'Terminal=false\nCategories=Graphics;AudioVideo;\nStartupWMClass=BeefTV\n')
            icons = stage / 'usr/share/pixmaps'
            icons.mkdir(parents=True)
            shutil.copy2(ROOT / 'assets/app-icon.png', icons / 'beeftv.png')
            bins = stage / 'usr/bin'
            bins.mkdir(parents=True)
            (bins / 'beeftv').symlink_to('/opt/beeftv/BeefTV-linux/cli/beeftv')
            # copytree keeps build modes, including Node and bundled CLI executables.
            for path in stage.rglob('*'):
                if path.is_dir():
                    path.chmod(0o755)
            subprocess.run(['dpkg-deb', '--root-owner-group', '--build', str(stage), str(output)], check=True)
    print(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', default=(ROOT / 'VERSION').read_text().strip())
    parser.add_argument('--platform', choices=SUFFIXES, required=True)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    payload = args.input or ROOT / 'backend/cmd/desktop/build/bin'
    if not args.input:
        if args.platform.startswith('darwin-'):
            payload /= 'BeefTV.app'
        elif args.platform == 'linux-amd64':
            payload /= 'BeefTV-linux'
    package(args.version, args.platform, payload, args.output_dir / installer_name(args.version, args.platform))


if __name__ == '__main__':
    main()
