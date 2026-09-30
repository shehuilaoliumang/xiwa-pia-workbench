"""Real current-anchor API <-> independent fan service compatibility check.

Run from the project root: runtime/python.exe -X utf8 tests/fan_exchange_compatibility.py
Uses only .qa data. Set FAN_EXE to a newly built isolated EXE to validate that
binary instead. The fan process imports its own modules; the anchor test
client imports the current root modules, so copied validators cannot conceal
a mismatch. The default source run does not validate any existing frozen EXE.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request
import uuid
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import create_app
import script_package as anchor_package
from PIL import Image

OUT = ROOT / '.qa' / ('fan-compatibility-' + uuid.uuid4().hex[:10])
PORT = 9041


def sha(data):
    return hashlib.sha256(data).hexdigest()


def asset_image():
    data = io.BytesIO()
    Image.new('RGB', (32, 24), (30, 110, 180)).save(data, format='PNG')
    return data.getvalue()


def asset_audio():
    data = io.BytesIO()
    with wave.open(data, 'wb') as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(8000)
        writer.writeframes(b'\0\0' * 16000)
    return data.getvalue()


def package_contents(blob):
    # This is the latest ANCHOR validator, not the fan's copied module.
    with anchor_package._validated(io.BytesIO(blob)) as package:
        return copy.deepcopy(package['script']), {
            ref: sha(package['paths'][member].read_bytes())
            for ref, member in package['mapping'].items()
        }


class Compatibility(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUT.mkdir(parents=True)
        cls.production = ROOT / 'instance' / 'workbench.sqlite3'
        cls.production_sha = sha(cls.production.read_bytes())
        cls.records = []
        cls.proc = None
        cls.log = None
        cls.csrf = ''
        cls.base = f'http://127.0.0.1:{PORT}'
        with socket.socket() as probe:
            probe.settimeout(.3)
            if probe.connect_ex(('127.0.0.1', PORT)) == 0:
                raise RuntimeError('QA port 9041 is occupied; never reuse a running service')
        data_dir = OUT / 'fan-data'
        cls.log = (OUT / 'fan-process.log').open('wb')
        frozen = os.environ.get('FAN_EXE')
        cls.mode = 'frozen EXE' if frozen else 'source'
        entry = ([str(Path(frozen).resolve())] if frozen else
                 [sys.executable, '-X', 'utf8', str(ROOT / '喜娃剧本粉丝编辑器' / 'fan_entry.py')])
        cls.proc = subprocess.Popen(
            [*entry, '--no-browser', '--port', str(PORT), '--data-dir', str(data_dir)],
            cwd=ROOT / '喜娃剧本粉丝编辑器', stdout=cls.log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            for _ in range(100):
                if cls.proc.poll() is not None:
                    raise RuntimeError('Fan source service exited; see fan-process.log')
                try:
                    status, body = cls.http('GET', '/api/health')
                    if status == 200 and json.loads(body)['app'] == 'xiwa-fan-editor':
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(.1)
            else:
                raise RuntimeError('Fan source service did not become ready')
            record = json.loads((data_dir / 'server.json').read_text(encoding='utf-8'))
            # PyInstaller onefile uses an outer unpacker and an inner service
            # process, so its record PID need not equal Popen's unpacker PID.
            assert record['url'] == cls.base + '/' and isinstance(record['pid'], int)
            if not frozen:
                assert record['pid'] == cls.proc.pid
            status, html = cls.http('GET', '/')
            assert status == 200
            cls.csrf = re.search(r'<meta name="csrf" content="([0-9a-f]+)">', html.decode()).group(1)
        except BaseException:
            cls.stop()
            raise

    @classmethod
    def http(cls, method, path, payload=None, upload=None):
        headers = {'X-CSRF-Token': cls.csrf}
        body = None
        if upload is not None:
            boundary = 'fan-compat-' + uuid.uuid4().hex
            headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="package"; '
                    'filename="exchange.zip"\r\nContent-Type: application/zip\r\n\r\n').encode()
            body += upload + f'\r\n--{boundary}--\r\n'.encode()
        elif payload is not None:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(payload, ensure_ascii=False).encode()
        request = urllib.request.Request(cls.base + path, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    @classmethod
    def stop(cls):
        if cls.proc is not None:
            try:
                if cls.csrf and cls.proc.poll() is None:
                    cls.http('POST', '/api/shutdown')
                cls.proc.wait(timeout=12)
            except (OSError, subprocess.TimeoutExpired):
                cls.proc.terminate()  # only the exact process started by this test
                cls.proc.wait(timeout=10)
        if cls.log is not None:
            cls.log.close()

    @classmethod
    def tearDownClass(cls):
        cls.stop()
        unchanged = sha(cls.production.read_bytes()) == cls.production_sha
        (OUT / 'result.json').write_text(json.dumps({
            'scope': 'Current anchor APIs and fan ' + cls.mode,
            'records': cls.records, 'production_unchanged': unchanged,
            'production_sha256': cls.production_sha,
            'source_modules': {'anchor': str(Path(anchor_package.__file__).resolve()),
                               'fan': str(ROOT / '喜娃剧本粉丝编辑器' / 'script_package.py')}
        }, ensure_ascii=False, indent=2), encoding='utf-8')
        assert unchanged, 'Production data changed during the test; investigate without restoring it'
        print('Evidence:', OUT / 'result.json')

    def setUp(self):
        self.folder = OUT / self._testMethodName
        self.folder.mkdir()
        source = self.folder / 'static' / 'media'
        source.mkdir(parents=True)
        (source / 'fixture.png').write_bytes(asset_image())
        seed = {'categories': [{'id': 'cat-source', 'name': '来源'}, {'id': 'cat-target', 'name': '接收'}],
                'scripts': [{'id': 'script-compat', 'title': '双系统兼容验证', 'category_id': 'cat-source',
                    'author': '原作者', 'notes': '原备注', 'source_pages': [7],
                    'role_colors': {'甲': '#aa2244', '预设角色': '#338866', 'constructor': '#446688'},
                    'blocks': [
                        {'id': 'block-original', 'kind': 'text', 'text': '保留\n多色与空格  ', 'role': '甲',
                         'color': '#aa2244', 'runs': [{'text': '保留\n', 'color': '#aa2244', 'bold': True},
                                                   {'text': '多色与空格  ', 'color': '#2244aa'}],
                         'source_page': 7, 'source_file': '测试来源.pptx', 'original_text': '保留原文'},
                        {'id': 'block-image', 'kind': 'image', 'text': '插图说明', 'image_path': '/static/media/fixture.png'},
                        {'id': 'block-exception', 'kind': 'text', 'text': '本句特殊色', 'role': '甲', 'color': '#775533'}]}]}
        seed_path = self.folder / 'seed.json'
        seed_path.write_text(json.dumps(seed, ensure_ascii=False), encoding='utf-8')
        self.app = create_app({'TESTING': True, 'PROJECT_ROOT': str(self.folder),
            'DATABASE': str(self.folder / 'instance' / 'workbench.sqlite3'),
            'INSTANCE_PATH': str(self.folder / 'instance'), 'SEED_PATH': str(seed_path)})
        self.client = self.app.test_client()
        self.token = self.app.extensions['csrf_token']
        self.anchor_upload('/api/scripts/script-compat/media', asset_audio(), filename='实验.wav')
        self.anchor_write('/api/scripts/script-compat/media/cues', {'duration': 2, 'cues': [
            {'id': 'cue-a', 'at': 0, 'label': '文字与图片', 'block_ids': ['block-original', 'block-image']},
            {'id': 'cue-b', 'at': 1, 'label': '特殊色台词', 'block_ids': ['block-exception']}]}, 'PUT')
        self.anchor_write('/api/queue', {'script_ids': ['script-compat']}, 'PUT')
        self.anchor_write('/api/apply', {'mode': 'script', 'script_id': 'script-compat', 'orientation': 'portrait'})

    def anchor_write(self, path, payload, method='POST'):
        response = self.client.open(path, method=method, json=payload, headers={'X-CSRF-Token': self.token})
        self.assertIn(response.status_code, [200, 201], response.get_data(as_text=True))
        return response.get_json()

    def anchor_upload(self, path, blob, fields=None, filename='exchange.zip', client=None, token=None):
        response = (client or self.client).post(path, data={
            'file': (io.BytesIO(blob), filename), **(fields or {})}, headers={'X-CSRF-Token': token or self.token})
        self.assertIn(response.status_code, [200, 201], response.get_data(as_text=True))
        result = response.get_json()
        response.close()
        response.request.close()
        response.request.environ['wsgi.input'].close()
        return result

    def export(self, script_id='script-compat', client=None):
        response = (client or self.client).get(f'/api/scripts/{script_id}/export')
        self.assertEqual(response.status_code, 200)
        result = bytes(response.data)
        response.close()
        return result

    def fan_json(self, method, path, payload=None, upload=None):
        status, body = self.http(method, path, payload, upload)
        self.assertIn(status, [200, 201], body.decode())
        return json.loads(body)

    def fan_roundtrip(self, blob):
        wsid = self.fan_json('POST', '/api/workspaces', upload=blob)['workspace']['id']
        status, exported = self.http('POST', f'/api/workspaces/{wsid}/export')
        self.assertEqual(status, 200, exported[:1000])
        return wsid, exported

    def test_01_current_fields_unedited_roundtrip_and_duplicate_skip(self):
        original = self.export()
        before_db = sha((self.folder / 'instance/workbench.sqlite3').read_bytes())
        _, returned = self.fan_roundtrip(original)
        self.assertEqual(package_contents(original), package_contents(returned))
        preview = self.anchor_upload('/api/script-packages/preview', returned)
        self.assertEqual(preview['status'], 'duplicate')
        imported = self.anchor_upload('/api/script-packages/import', returned, {
            'category_id': 'cat-target', 'expected_sha256': preview['package_sha256'], 'action': 'new'})
        self.assertEqual(imported['reason'], 'duplicate')
        self.assertEqual(sha((self.folder / 'instance/workbench.sqlite3').read_bytes()), before_db)
        self.records.append({'check': self._testMethodName, 'passed': True})

    def test_02_fan_edits_explicit_overwrite_keep_live_and_cues(self):
        original = self.export()
        wsid, _ = self.fan_roundtrip(original)
        item = self.fan_json('GET', f'/api/workspaces/{wsid}')['script']
        original_runs = copy.deepcopy(item['blocks'][0]['runs'])
        item['role_colors']['甲'] = '#448866'
        item['blocks'][2]['text'] = '粉丝修改的台词'
        item['blocks'].append({'id': 'fan-added', 'kind': 'text', 'text': '新增句', 'role': '甲', 'color': '#448866'})
        self.fan_json('PUT', f'/api/workspaces/{wsid}', item)
        _, returned = self.http('POST', f'/api/workspaces/{wsid}/export')
        preview = self.anchor_upload('/api/script-packages/preview', returned)
        self.assertEqual(preview['status'], 'conflict')
        frozen = self.client.get('/api/state').get_json()
        queue = self.client.get('/api/library').get_json()['queue']
        skipped = self.anchor_upload('/api/script-packages/import', returned, {
            'category_id': 'cat-source', 'expected_sha256': preview['package_sha256'], 'action': 'skip'})
        self.assertTrue(skipped['skipped'])
        match = next(value for value in preview['matches'] if value['id'] == 'script-compat')
        replaced = self.anchor_upload('/api/script-packages/import', returned, {
            'category_id': 'cat-source', 'expected_sha256': preview['package_sha256'], 'action': 'overwrite',
            'target_id': match['id'], 'expected_target_fingerprint': match['fingerprint']})
        self.assertTrue(replaced['overwritten'])
        self.assertEqual(replaced['script']['id'], 'script-compat')
        self.assertEqual(replaced['script']['role_colors'], item['role_colors'])
        self.assertEqual(replaced['script']['blocks'][0]['runs'], original_runs)
        self.assertEqual([b['text'] for b in replaced['script']['blocks']], [b['text'] for b in item['blocks']])
        mapped_ids = [b['id'] for b in replaced['script']['blocks']]
        self.assertEqual(replaced['script']['media']['cues'][0]['block_ids'], mapped_ids[:2])
        self.assertEqual(self.client.get('/api/state').get_json(), frozen)
        self.assertEqual(self.client.get('/api/library').get_json()['queue'], queue)
        self.assertTrue(self.client.get('/api/scripts/script-compat/history').get_json()['history'])
        self.assertEqual(sorted(package_contents(original)[1].values()), sorted(package_contents(self.export())[1].values()))
        self.records.append({'check': self._testMethodName, 'passed': True})

    def test_03_fan_create_text_import_exports_to_current_anchor(self):
        preview = self.fan_json('POST', '/api/import-preview', {'text': '剧名：粉丝新本\n作者：测试\n\n甲：新台词\n\n乙：第二句'})
        candidate = preview['candidate']
        candidate['role_colors'] = {'甲': '#114477', '__proto__': '#662244'}
        wsid = self.fan_json('POST', '/api/workspaces/new', candidate)['workspace']['id']
        status, blob = self.http('POST', f'/api/workspaces/{wsid}/export')
        self.assertEqual(status, 200)
        check = self.anchor_upload('/api/script-packages/preview', blob)
        self.assertEqual(check['status'], 'new')
        result = self.anchor_upload('/api/script-packages/import', blob, {
            'category_id': 'cat-target', 'expected_sha256': check['package_sha256'], 'action': 'new'})
        self.assertEqual(result['script']['role_colors'], candidate['role_colors'])
        # Title/author lines remain source text under the shared parser rules;
        # only genuinely blank lines are omitted from the candidate.
        self.assertEqual(len(candidate['blocks']), 4)
        self.assertEqual(len(result['script']['blocks']), len(candidate['blocks']))
        self.assertEqual([b['text'] for b in result['script']['blocks']], [b['text'] for b in candidate['blocks']])
        self.records.append({'check': self._testMethodName, 'passed': True})

    def test_04_empty_palette_remains_compatible(self):
        self.anchor_write('/api/scripts/script-compat', {'role_colors': {}}, 'PATCH')
        _, returned = self.fan_roundtrip(self.export())
        self.assertEqual(package_contents(returned)[0]['role_colors'], {})
        self.assertEqual(self.anchor_upload('/api/script-packages/preview', returned)['status'], 'duplicate')
        self.records.append({'check': self._testMethodName, 'passed': True})

    def test_05_current_16_script_library_export_fan_export_current_anchor(self):
        clone = OUT / 'current-library-copy'
        data_dir = clone / 'instance'
        data_dir.mkdir(parents=True)
        with sqlite3.connect(self.production.resolve().as_uri() + '?mode=ro', uri=True) as source:
            with sqlite3.connect(data_dir / 'workbench.sqlite3') as destination:
                source.backup(destination)
        source_media = self.production.parent / 'media'
        if source_media.exists():
            shutil.copytree(source_media, data_dir / 'media')
        app = create_app({'TESTING': True, 'PROJECT_ROOT': str(ROOT),
            'DATABASE': str(data_dir / 'workbench.sqlite3'), 'INSTANCE_PATH': str(data_dir)})
        client = app.test_client()
        token = app.extensions['csrf_token']
        library = client.get('/api/library').get_json()
        details = []
        before = sha((data_dir / 'workbench.sqlite3').read_bytes())
        for script in library['scripts']:
            original = self.export(script['id'], client)
            _, returned = self.fan_roundtrip(original)
            self.assertEqual(package_contents(original), package_contents(returned), script['title'])
            check = self.anchor_upload('/api/script-packages/preview', returned, client=client, token=token)
            self.assertEqual(check['status'], 'duplicate', script['title'])
            details.append({'id': script['id'], 'title': script['title'], 'passed': True})
        self.assertEqual(sha((data_dir / 'workbench.sqlite3').read_bytes()), before)
        self.records.append({'check': self._testMethodName, 'passed': True, 'scripts': details})


if __name__ == '__main__':
    unittest.main(verbosity=2)
