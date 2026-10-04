"""Build a portable Windows handoff from a consistent online or read-only snapshot.

Maintenance only. Never initializes a Store against the daily database.
"""
from __future__ import annotations

from datetime import datetime
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import threading
import urllib.request
from urllib.parse import urlsplit
import zipfile

ROOT = Path(__file__).resolve().parents[1]
STAMP = datetime.now().strftime('%Y%m%d-%H%M%S')
QA = ROOT / '.qa' / 'package' / STAMP
NAME = '内容管理工作台'
STAGE = QA / 'stage' / NAME
DEST = ROOT / '交付包'
ARCHIVE_NAME = f'{NAME}_Windows免安装版_{STAMP}.zip'


def digest(content):
    return hashlib.sha256(content).hexdigest()


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def request(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(url, timeout=180)


def offline_snapshot():
    """Copy via SQLite's read-only backup API; never initialize the daily Store."""
    from storage import Store

    source = ROOT / 'instance/workbench.sqlite3'
    clone = QA / 'offline-source.sqlite3'
    before = digest(source.read_bytes())
    origin = sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)
    destination = sqlite3.connect(clone)
    try:
        origin.backup(destination)
    finally:
        destination.close()
        origin.close()

    class SnapshotStore(Store):
        def __init__(self):
            # Deliberately bypass Store._initialize: preserve the copied state.
            # DB reads/temporary backup files are confined to QA; assets are read
            # from their normal locations by the existing validated exporter.
            self.database = clone
            self.project_root = ROOT
            self.instance_dir = QA
            self.media_dir = ROOT / 'instance/media'
            self.lock = threading.RLock()

    snapshot = SnapshotStore().backup()
    after = digest(source.read_bytes())
    write_json(QA / 'offline-source-check.json', {
        'source_database': str(source), 'opened_as': 'mode=ro',
        'source_sha256_before': before, 'source_sha256_after': after,
        'source_bytes_unchanged': before == after,
        'clone_sha256': digest(clone.read_bytes()),
    })
    if before != after:
        raise RuntimeError('资料库在离线打包时发生变化；请使用在线备份或停止编辑后重试。')
    return snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true',
                        help='Read-only SQLite snapshot without starting the workbench')
    args = parser.parse_args()
    desktop_marker = ROOT / 'desktop/runtime/desktop-runtime.json'
    if not desktop_marker.exists() or not (ROOT / 'desktop/runtime/electron.exe').is_file():
        raise SystemExit('桌面交付包缺少运行时；请先运行 tools/prepare_desktop_runtime.py。')
    desktop_info = json.loads(desktop_marker.read_text(encoding='utf-8'))
    desktop_lock = json.loads((ROOT / 'tools/desktop-runtime-lock.json').read_text(encoding='utf-8'))
    if desktop_info.get('archive_sha256') != desktop_lock['sha256'] or desktop_info.get('executable_sha256') != digest((ROOT / 'desktop/runtime/electron.exe').read_bytes()):
        raise SystemExit('桌面运行环境校验不符，未打包。')
    QA.mkdir(parents=True, exist_ok=False)
    STAGE.mkdir(parents=True)
    DEST.mkdir(exist_ok=True)
    if args.offline:
        print('Exporting a read-only SQLite snapshot without starting the workbench...', flush=True)
        snapshot = offline_snapshot()
    else:
        record = json.loads((ROOT / 'instance/server.json').read_text(encoding='utf-8'))
        url = record['url']
        parsed = urlsplit(url)
        assert parsed.scheme == 'http' and parsed.hostname == '127.0.0.1'
        assert parsed.path == '/' and not parsed.query and not parsed.fragment
        assert not parsed.username and not parsed.password
        with request(url + 'api/health') as response:
            health = json.load(response)
        assert health['app'] == 'content-workbench'
        assert Path(health['data_dir']).resolve() == (ROOT / 'instance').resolve()
        print('Exporting a consistent snapshot from the running workbench...', flush=True)
        with request(url + 'api/backup') as response:
            snapshot = response.read()
    (QA / 'source-snapshot.zip').write_bytes(snapshot)

    copy_dirs = ['desktop', 'data', 'docs', 'evidence', 'runtime', 'static', 'templates', 'tests', 'tools', 'vendor']
    copy_files = ['app.py', 'import_parser.py', 'script_package.py', 'script_merge.py', 'storage.py', 'run.py', 'README.md',
                  'PROJECT_CONTEXT.md', 'requirements.txt', '启动工作台.cmd', '停止工作台.cmd',
                  '00-先看这里-3步启动.txt', '00-先看这里-图文启动.html', '浏览器模式.cmd']
    for name in copy_dirs:
        for source in sorted((ROOT / name).rglob('*')):
            if source.is_symlink():
                raise ValueError(f'Symlink must be reviewed before packaging: {source}')
            if any(part.startswith('.runtime-') for part in source.parts):
                continue
            if not source.is_file() or '__pycache__' in source.parts or source.suffix in {'.pyc', '.pyo'}:
                continue
            target = STAGE / source.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    for name in copy_files:
        shutil.copy2(ROOT / name, STAGE / name)
    # Preserve user-owned historical backups and any additional stored media.
    for folder in ['backups', 'media']:
        base = ROOT / 'instance' / folder
        for source in sorted(base.rglob('*')):
            if source.is_symlink():
                raise ValueError(f'Symlink must be reviewed: {source}')
            if not source.is_file():
                continue
            if folder == 'backups':
                if source.suffix.lower() != '.zip':
                    continue
                with zipfile.ZipFile(source) as old_backup:
                    assert old_backup.testzip() is None
            target = STAGE / source.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

    with zipfile.ZipFile(io.BytesIO(snapshot)) as archive:
        assert archive.testzip() is None
        manifest = json.loads(archive.read('manifest.json'))
        assert manifest['format'] == 'content-workbench-backup'
        for name, expected in manifest['files'].items():
            content = archive.read(name)
            assert len(content) == expected['size'] and digest(content) == expected['sha256']
        database = STAGE / 'instance/workbench.sqlite3'
        database.parent.mkdir(exist_ok=True)
        database.write_bytes(archive.read('database.sqlite3'))
        for resource, member in manifest['resources'].items():
            relative = PurePosixPath(resource.lstrip('/'))
            assert '..' not in relative.parts and relative.parts[0] in {'media', 'static'}
            if relative.parts[0] == 'media':
                target = STAGE / 'instance' / Path(*relative.parts)
            else:
                assert relative.parts[:2] == ('static', 'media')
                target = STAGE / Path(*relative.parts)
            assert target.resolve().is_relative_to(STAGE.resolve())
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(member))
    connection = sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)
    try:
        assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        scripts = [json.loads(row[0]) for row in connection.execute('SELECT data FROM scripts')]
        categories = [json.loads(row[0]) for row in connection.execute('SELECT data FROM categories')]
        settings = {k: json.loads(v) for k, v in connection.execute('SELECT key,data FROM settings')}
        summary = {'scripts': len(scripts), 'categories': len(categories),
                   'history_records': connection.execute('SELECT count(*) FROM history').fetchone()[0],
                   'media': [{'title': s['title'], 'path': s['media']['path'],
                              'sha256': s['media']['sha256'],
                              'cues': [{'at': c['at'], 'block_ids': c['block_ids']} for c in s['media']['cues']]}
                             for s in scripts if s.get('media')],
                   'layout_presets': settings.get('layout_presets', [])}
    finally:
        connection.close()
    info = {'format': 'content-portable-windows', 'built_at': datetime.now().astimezone().isoformat(),
            'snapshot_method': 'read-only-sqlite' if args.offline else 'running-app-backup',
            'snapshot_created_at': manifest['created_at'], 'snapshot_sha256': digest(snapshot),
            'database_sha256': digest(database.read_bytes()),
            'platform': 'Windows 10/11 x64; writable local folder; bundled Electron desktop and browser fallback',
            'desktop_runtime': desktop_info,
            'includes': copy_dirs + copy_files + ['instance/workbench.sqlite3', 'instance/media/', 'instance/backups/'],
            'excludes': ['.git/', '.qa/', '__pycache__/', '*.pyc', '*.pyo',
                         'instance/server.json', 'instance/server.lock',
                         'instance/*.log', 'instance/desktop-user-data/', 'desktop/.runtime-*/', '交付包/'],
            'notes': ['当前资料及历史版本保存在数据库快照中；已有备份ZIP也保留在instance/backups中。',
                      '首次启动会暂停展示，源项目当前播放状态不会被打包过程改变。',
                      '浏览器保存的本机操作偏好不在ZIP中；请按启动说明确认逐步应用。'],
            'snapshot_summary': summary}
    write_json(STAGE / 'docs/交付包信息.json', info)
    paths = sorted(p for p in STAGE.rglob('*') if p.is_file())
    files = {p.relative_to(STAGE).as_posix(): {'size': p.stat().st_size, 'sha256': digest(p.read_bytes())}
             for p in paths}
    write_json(STAGE / 'docs/交付文件清单.json', {'algorithm': 'sha256', 'files': files,
                                             'note': '清单自身不包含在逐文件哈希中。'})
    temporary = DEST / (ARCHIVE_NAME + '.partial')
    final = DEST / ARCHIVE_NAME
    assert not temporary.exists() and not final.exists()
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(p for p in STAGE.rglob('*') if p.is_file()):
            archive.write(path, arcname=f'{NAME}/{path.relative_to(STAGE).as_posix()}')
    with zipfile.ZipFile(temporary) as archive:
        assert archive.testzip() is None
    temporary.rename(final)
    shutil.copy2(ROOT / '00-先看这里-3步启动.txt', DEST / '先看这里-3步启动.txt')
    archive_hash = digest(final.read_bytes())
    (DEST / (ARCHIVE_NAME + '.sha256.txt')).write_text(archive_hash + '  ' + ARCHIVE_NAME + '\n', encoding='utf-8')
    result = {'archive': str(final), 'sha256': archive_hash, 'size': final.stat().st_size,
              'files': len(files) + 1, 'unpacked_size': sum(p.stat().st_size for p in STAGE.rglob('*') if p.is_file()),
              'stage': str(STAGE), 'qa': str(QA), 'snapshot_summary': summary,
              'guide': str(DEST / '先看这里-3步启动.txt')}
    write_json(QA / 'build-result.json', result)
    write_json(ROOT / '.qa/package/latest-build.json', result)
    print(json.dumps({k: v for k, v in result.items() if k != 'snapshot_summary'}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
