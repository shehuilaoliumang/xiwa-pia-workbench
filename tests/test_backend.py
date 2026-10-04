"""Integration coverage for source fidelity, live state and safe recovery."""
import copy
import hashlib
import io
import json
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import struct
import zlib

from PIL import Image
from pathlib import Path

from app import create_app
from storage import DomainError


class WorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='wb-backend-')
        self.root = Path(self.temporary.name)
        (self.root / 'static' / 'media').mkdir(parents=True)
        (self.root / 'static' / 'media' / 'source.png').write_bytes(b'\x89PNG\r\nsource-image')
        self.seed = {
            'categories': [
                {'id': 'cat-a', 'name': '甜本', 'color': '#cc8899', 'background': '/static/media/source.png', 'sort_order': 0, 'visible': True},
                {'id': 'cat-b', 'name': '淡本', 'sort_order': 1, 'visible': True},
            ],
            'scripts': [
                {'id': 'script-a', 'title': '示例条目', 'category_id': 'cat-a', 'source_category': '甜本',
                 'author': '原作者', 'source_pages': [7, 8], 'blocks': [
                     {'id': 'para-1', 'kind': 'text', 'text': '甲：第一句。', 'role': '甲', 'source_page': 7, 'source_file': '来源.pptx', 'runs': [{'text': '甲：第一句。', 'color': '#c06080'}]},
                     {'id': 'para-2', 'kind': 'text', 'text': '乙：第二句。', 'role': '乙', 'source_page': 8, 'source_file': '来源.pptx'},
                     {'id': 'image-1', 'kind': 'image', 'text': '', 'image_path': '/static/media/source.png', 'source_page': 8, 'source_file': '来源.pptx'},
                 ]},
                {'id': 'script-b', 'title': '另一篇', 'category_id': 'cat-b', 'source_category': '淡本', 'source_pages': [9],
                 'blocks': [{'id': 'other-1', 'kind': 'text', 'text': '旁白：另一段。', 'source_page': 9, 'source_file': '来源.pptx'}]},
            ],
        }
        self.seed_file = self.root / 'seed.json'
        self.seed_file.write_text(json.dumps(self.seed, ensure_ascii=False), encoding='utf-8')
        self.config = {'TESTING': True, 'DATABASE': str(self.root / 'instance' / 'workbench.sqlite3'),
                       'INSTANCE_PATH': str(self.root / 'instance'), 'SEED_PATH': str(self.seed_file), 'PROJECT_ROOT': str(self.root)}
        self.app = create_app(self.config)
        self.client = self.app.test_client()
        self.token = self.library()['csrf_token']

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, path, payload=None, method='POST', expected=200):
        response = self.client.open(path, method=method, json={} if payload is None else payload,
                                    headers={'X-CSRF-Token': self.token})
        self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
        return response.get_json()

    def library(self):
        return self.client.get('/api/library').get_json()

    def apply_script(self, script_id='script-a', **kwargs):
        return self.write('/api/apply', {'mode': 'script', 'script_id': script_id, 'orientation': 'portrait',
                                         'layout': {'body_mode': 'scroll'}, **kwargs})

    def restore(self, archive, expected=200):
        response = self.client.post('/api/restore', data={'file': (io.BytesIO(archive), 'backup.zip')}, headers={'X-CSRF-Token': self.token})
        self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
        return response.get_json()

    @staticmethod
    def picture(fmt="PNG", shade=(30, 80, 120)):
        output = io.BytesIO()
        Image.new("RGB", (16, 24), shade).save(output, format=fmt)
        return output.getvalue()

    def upload(self, content=None, filename="example.png", name="新背景", expected=201):
        response = self.client.post('/api/backgrounds',
                                    data={'file': (io.BytesIO(self.picture() if content is None else content), filename), 'name': name},
                                    headers={'X-CSRF-Token': self.token})
        self.assertEqual(response.status_code, expected, response.get_data(as_text=True))
        result = response.get_json()
        response.close()
        response.request.close()
        response.request.environ["wsgi.input"].close()
        return result

    def alter_backup(self, backup, mutate_database=None, mutate_files=None):
        with zipfile.ZipFile(io.BytesIO(backup)) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        if mutate_database:
            database = self.root / 'alter-backup.sqlite3'
            database.write_bytes(files['database.sqlite3'])
            connection = sqlite3.connect(database)
            try:
                mutate_database(connection)
                connection.commit()
            finally:
                connection.close()
            files['database.sqlite3'] = database.read_bytes()
        if mutate_files:
            mutate_files(files)
        manifest = json.loads(files['manifest.json'])
        for name in manifest['files']:
            manifest['files'][name] = {'size': len(files[name]), 'sha256': hashlib.sha256(files[name]).hexdigest()}
        files['manifest.json'] = json.dumps(manifest).encode()
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            for name, content in files.items():
                archive.writestr(name, content)
        return output.getvalue()

    def test_two_level_directory_preserves_empty_categories_and_distinct_anchors(self):
        self.write('/api/categories', {'id': 'cat-empty', 'name': '空分组'}, expected=201)
        payload = {'mode': 'list', 'directory_level': 'categories', 'list_source': 'categories'}
        preview = self.write('/api/preview', payload)
        self.assertEqual({item['id'] for item in preview['categories']}, {'cat-a', 'cat-b', 'cat-empty'})
        self.assertEqual({item['id'] for item in preview['scripts']}, {'script-a', 'script-b'})
        self.assertIsNone(preview['focus_category_id'])
        state = self.write('/api/apply', {**payload, 'preview_token': preview['content_token'], 'preview_anchor': 'category:cat-empty'})
        self.assertEqual(state['anchor'], 'category:cat-empty')
        self.write('/api/checkpoint', {'revision': state['revision'], 'anchor': 'category:cat-a'})
        self.write('/api/command', {'action': 'seek', 'anchor': 'script:script-a'}, expected=409)
        self.write('/api/command', {'action': 'play'})
        focused = self.write('/api/preview', {**payload, 'directory_level': 'scripts', 'focus_category_id': 'cat-empty'})
        self.assertEqual(focused['scripts'], [])
        self.assertEqual([item['id'] for item in focused['categories']], ['cat-empty'])
        self.assertEqual(focused['selection']['focus_category_id'], 'cat-empty')
        self.assertEqual(self.library()['state']['anchor'], 'category:cat-a')

    def test_focused_directory_respects_queue_and_legacy_flat_selection(self):
        legacy = self.write('/api/preview', {'mode': 'list'})
        self.assertEqual(legacy['directory_level'], 'scripts')
        self.assertEqual(len(legacy['scripts']), 2)
        focused = self.write('/api/preview', {'mode': 'list', 'directory_level': 'scripts',
                                             'focus_category_id': 'cat-a', 'category_ids': ['cat-b'], 'list_source': 'categories'})
        self.assertEqual([item['id'] for item in focused['scripts']], ['script-a'])
        queue = {'mode': 'list', 'directory_level': 'categories', 'list_source': 'queue', 'script_ids': ['script-b']}
        queued = self.write('/api/preview', queue)
        self.assertEqual([item['id'] for item in queued['categories']], ['cat-b'])
        empty = self.write('/api/preview', {**queue, 'directory_level': 'scripts', 'focus_category_id': 'cat-a'})
        self.assertEqual(empty['scripts'], [])
        empty_overview = self.write('/api/preview', {**queue, 'script_ids': []})
        self.assertEqual(empty_overview['categories'], [])
        self.assertEqual(empty_overview['scripts'], [])
        script = self.write('/api/preview', {'mode': 'script', 'script_id': 'script-a'})
        self.assertEqual(script['focus_category_id'], 'cat-a')
        self.assertEqual(script['selection']['directory_level'], 'scripts')
        self.write('/api/preview', {'mode': 'script', 'script_id': 'script-a', 'focus_category_id': 'cat-b'}, expected=409)

    def test_unavailable_focus_never_falls_back_or_changes_live(self):
        payload = {'mode': 'list', 'directory_level': 'scripts', 'focus_category_id': 'cat-a', 'list_source': 'categories'}
        initial = self.write('/api/apply', payload)
        self.write('/api/categories/cat-a', {'visible': False}, method='PATCH')
        self.write('/api/preview', payload, expected=409)
        self.write('/api/apply', payload, expected=409)
        self.write('/api/categories/cat-a', {'target_id': 'cat-b'}, method='DELETE')
        self.write('/api/apply', payload, expected=409)
        self.assertEqual(self.library()['state'], initial)
        for malformed in ({'directory_level': []}, {'directory_level': 'wrong'},
                          {'directory_level': 'categories', 'focus_category_id': 'cat-b'}):
            self.write('/api/preview', {'mode': 'list', **malformed}, expected=400)

    def test_pre_directory_upgrade_snapshot_retains_existing_script_position(self):
        self.apply_script(preview_anchor='para-2')
        store = self.app.extensions['store']
        with store.transaction(write=True) as connection:
            state = store._setting(connection, 'state')
            for item in (state['snapshot'], state['snapshot']['selection']):
                item.pop('directory_level', None)
                item.pop('focus_category_id', None)
            store._save_setting(connection, 'state', state)
        refreshed = self.apply_script(orientation='landscape')
        self.assertEqual(refreshed['anchor'], 'para-2')
        self.assertEqual(refreshed['snapshot']['directory_level'], 'scripts')

    def test_category_snapshot_and_anchor_survive_restore_with_deleted_library_category(self):
        state = self.write('/api/apply', {'mode': 'list', 'directory_level': 'categories',
                                         'preview_anchor': 'category:cat-a'})
        self.write('/api/categories/cat-a', {'target_id': 'cat-b'}, method='DELETE')
        self.restore(self.client.get('/api/backup').data)
        restored = self.library()['state']
        self.assertEqual(restored['anchor'], 'category:cat-a')
        self.assertEqual(restored['snapshot']['directory_level'], 'categories')
        self.assertEqual(restored['snapshot']['selection']['directory_level'], 'categories')
        self.assertEqual(restored['snapshot']['id'], state['snapshot']['id'])
        self.assertFalse(restored['playing'])

    def test_old_backup_without_background_library_and_directory_fields_restores(self):
        self.apply_script(preview_anchor='para-2')
        def old_format(connection):
            connection.execute("DELETE FROM settings WHERE key='backgrounds'")
            state = json.loads(connection.execute("SELECT data FROM settings WHERE key='state'").fetchone()[0])
            for item in (state['snapshot'], state['snapshot']['selection']):
                item.pop('directory_level', None)
                item.pop('focus_category_id', None)
            connection.execute("UPDATE settings SET data=? WHERE key='state'", (json.dumps(state),))
        old = self.alter_backup(self.client.get('/api/backup').data, old_format)
        self.restore(old)
        self.assertEqual(self.library()['state']['anchor'], 'para-2')
        self.assertEqual(self.library()['state']['snapshot']['focus_category_id'], 'cat-a')
        backgrounds = self.client.get('/api/backgrounds').get_json()['backgrounds']
        self.assertEqual(len(backgrounds), 1)
        self.assertTrue(backgrounds[0]['builtin'])
        self.assertTrue(backgrounds[0]['path'].startswith('/media/'))

    @staticmethod
    def failing_resource_open(target, failure):
        actual_open = Path.open
        class FailingWriter:
            def __init__(self, handle):
                self.handle = handle
            def __enter__(self):
                return self
            def write(self, content):
                if failure == 'write':
                    self.handle.write(content[:max(1, len(content) // 2)])
                    self.handle.flush()
                    raise OSError('simulated partial image write failure')
                return self.handle.write(content)
            def __exit__(self, kind, error, traceback):
                self.handle.close()
                if failure == 'close':
                    raise OSError('simulated image close failure')
        def opened(path, mode='r', *args, **kwargs):
            handle = actual_open(path, mode, *args, **kwargs)
            return FailingWriter(handle) if path == target and mode == 'xb' else handle
        return opened

    def test_upload_resource_write_and_close_failure_cleanup_allow_retry(self):
        store = self.app.extensions['store']
        # A previous completed upload supplies the exact sanitized content hash;
        # delete it so each simulated failure must create that file anew.
        for failure in ('write', 'close'):
            with self.subTest(failure=failure):
                item = self.upload()
                target = store.resource_file(item['path'])
                self.write('/api/backgrounds/' + item['id'], method='DELETE')
                before = self.library()
                with patch.object(Path, 'open', self.failing_resource_open(target, failure)):
                    error = self.upload(expected=503)
                    self.assertEqual(error['code'], 'resource_write_failed')
                self.assertFalse(target.exists())
                self.assertEqual(self.library()['backgrounds'], before['backgrounds'])
                self.assertEqual(self.library()['state'], before['state'])
                retried = self.upload()
                self.assertTrue(target.is_file())
                self.write('/api/backgrounds/' + retried['id'], method='DELETE')

    def test_upload_metadata_rollback_keeps_existing_identical_resource(self):
        item = self.upload()
        store = self.app.extensions['store']
        target = store.resource_file(item['path'])
        content = target.read_bytes()
        # Model a complete, unreferenced file left by an interrupted earlier
        # operation; the current attempt must not claim ownership of this file.
        with store.transaction(write=True) as connection:
            entries = [entry for entry in store._setting(connection, 'backgrounds') if entry['id'] != item['id']]
            store._save_setting(connection, 'backgrounds', entries)
        before = self.library()
        with patch.object(store, '_save_setting', side_effect=DomainError('simulated database write failure', 503)):
            self.upload(expected=503)
        self.assertEqual(target.read_bytes(), content)
        self.assertEqual(self.library()['backgrounds'], before['backgrounds'])
        self.assertEqual(self.library()['state'], before['state'])
        self.upload()

    def test_restore_resource_write_and_close_failure_preserve_library_and_allow_retry(self):
        item = self.upload()
        backup = self.client.get('/api/backup').data
        for failure in ('write', 'close'):
            with self.subTest(failure=failure):
                other_root = self.root / ('failed-restore-' + failure)
                other = create_app({**self.config, 'DATABASE': str(other_root / 'workbench.sqlite3'),
                                    'INSTANCE_PATH': str(other_root)})
                store = other.extensions['store']
                target = store.resource_file(item['path'])
                before = store.library()
                with patch.object(Path, 'open', self.failing_resource_open(target, failure)):
                    with self.assertRaises(DomainError) as raised:
                        store.restore(io.BytesIO(backup))
                    self.assertEqual(raised.exception.code, 'resource_write_failed')
                self.assertFalse(target.exists())
                self.assertEqual(store.library(), before)
                store.restore(io.BytesIO(backup))
                self.assertTrue(target.is_file())
                self.assertTrue(any(entry['id'] == item['id'] for entry in store.backgrounds()))

    def test_background_upload_rename_delete_and_builtin_protection(self):
        builtin = self.client.get('/api/backgrounds').get_json()['backgrounds'][0]
        self.assertTrue(builtin['builtin'])
        self.assertFalse(builtin['can_delete'])
        error = self.write('/api/backgrounds/' + builtin['id'], method='DELETE', expected=409)
        self.assertEqual(error['code'], 'builtin_background')
        renamed_builtin = self.write('/api/backgrounds/' + builtin['id'], {'name': '原图保留'}, method='PATCH')
        self.assertEqual(renamed_builtin['name'], '原图保留')
        item = self.upload()
        self.assertEqual((item['width'], item['height'], item['mime']), (16, 24, 'image/png'))
        self.assertTrue(item['can_delete'])
        self.assertFalse(item['builtin'])
        response = self.client.get(item['path'])
        self.assertEqual(response.status_code, 200)
        with Image.open(io.BytesIO(response.data)) as decoded:
            decoded.load()
        response.close()
        self.upload(expected=409)
        renamed = self.write('/api/backgrounds/' + item['id'], {'name': '重命名'}, method='PATCH')
        self.assertEqual(renamed['name'], '重命名')
        self.assertEqual(renamed['path'], item['path'])
        self.write('/api/backgrounds/' + item['id'], method='DELETE')
        self.assertEqual(self.client.get(item['path']).status_code, 404)
        self.assertEqual(len(self.client.get('/api/backgrounds').get_json()['backgrounds']), 1)
        self.assertTrue((self.root / 'static/media/source.png').is_file())

    def test_background_category_and_live_references_protect_until_cleared(self):
        item = self.upload()
        self.write('/api/categories/cat-a', {'background': item['path']}, method='PATCH')
        state = self.apply_script()
        error = self.write('/api/backgrounds/' + item['id'], method='DELETE', expected=409)
        self.assertEqual(error['code'], 'background_in_use')
        self.assertIn('甜本', error['error'])
        self.write('/api/categories/cat-a', {'background': ''}, method='PATCH')
        self.assertEqual(self.library()['state'], state)
        protected = next(entry for entry in self.client.get('/api/backgrounds').get_json()['backgrounds'] if entry['id'] == item['id'])
        self.assertEqual(protected['usage']['categories'], [])
        self.assertTrue(protected['usage']['live'])
        self.write('/api/backgrounds/' + item['id'], method='DELETE', expected=409)
        self.apply_script()
        self.write('/api/backgrounds/' + item['id'], method='DELETE')

    def test_background_history_keeps_original_resource_after_body_replacement(self):
        item = self.upload()
        script = self.library()['scripts'][0]
        blocks = copy.deepcopy(script['blocks'])
        blocks[-1]['image_path'] = item['path']
        self.write('/api/scripts/script-a', {'blocks': blocks}, method='PATCH')
        self.write('/api/backgrounds/' + item['id'], method='DELETE', expected=409)
        self.write('/api/scripts/script-a', {'blocks': script['blocks']}, method='PATCH')
        entry = next(entry for entry in self.client.get('/api/backgrounds').get_json()['backgrounds'] if entry['id'] == item['id'])
        self.assertEqual(entry['usage']['scripts'], [])
        self.assertEqual(entry['usage']['history'], 1)
        error = self.write('/api/backgrounds/' + item['id'], method='DELETE', expected=409)
        self.assertIn('历史', error['error'])

    def test_background_formats_and_invalid_uploads_leave_library_unchanged(self):
        self.upload(self.picture('JPEG'), 'sample.jpg')
        self.upload(self.picture('WEBP'), 'sample.webp')
        before = self.library()
        media_before = set((self.root / 'instance/media').iterdir())
        bad_png = bytearray(self.picture())
        bad_png[16:20] = struct.pack('>I', 13001)
        bad_png[29:33] = struct.pack('>I', zlib.crc32(bad_png[12:29]))
        for content, filename in [(b'<svg xmlns="http://www.w3.org/2000/svg"/>', 'bad.svg'),
                                  (b'<html>fake</html>', 'fake.png'), (self.picture(), 'fake.jpg'),
                                  (self.picture('GIF'), 'fake.gif'), (self.picture()[:40], 'broken.png'),
                                  (bytes(bad_png), 'large.png'), (b'x' * (12 * 1024 * 1024 + 1), 'huge.png')]:
            with self.subTest(filename=filename):
                error = self.upload(content, filename, expected=400)
                self.assertEqual(error['code'], 'invalid_image')
        self.assertEqual(self.library()['backgrounds'], before['backgrounds'])
        self.assertEqual(self.library()['state'], before['state'])
        self.assertEqual(set((self.root / 'instance/media').iterdir()), media_before)

    def test_unreferenced_backgrounds_and_metadata_survive_migration_and_remain_editable(self):
        item = self.upload(name='尚未使用的图片')
        self.write('/api/backgrounds/' + item['id'], {'name': '迁移前名称'}, method='PATCH')
        backup = self.client.get('/api/backup').data
        other_root = self.root / 'background-migration'
        other = create_app({**self.config, 'DATABASE': str(other_root / 'workbench.sqlite3'), 'INSTANCE_PATH': str(other_root)})
        client = other.test_client()
        headers = {'X-CSRF-Token': client.get('/api/library').get_json()['csrf_token']}
        response = client.post('/api/restore', data={'file': (io.BytesIO(backup), 'backup.zip')}, headers=headers)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        restored = next(entry for entry in client.get('/api/backgrounds').get_json()['backgrounds'] if entry['id'] == item['id'])
        self.assertEqual(restored['name'], '迁移前名称')
        self.assertTrue(restored['can_delete'])
        self.assertEqual((restored['width'], restored['height']), (16, 24))
        image_response = client.get(restored['path'])
        self.assertEqual(image_response.status_code, 200)
        image_response.close()
        self.assertEqual(client.patch('/api/backgrounds/' + item['id'], json={'name': '迁移后名称'}, headers=headers).status_code, 200)
        self.assertEqual(client.delete('/api/backgrounds/' + item['id'], headers=headers).status_code, 200)
        self.assertEqual(client.get(restored['path']).status_code, 404)
        self.assertEqual(self.client.get('/api/backgrounds').get_json()['backgrounds'][-1]['id'], item['id'])

    def test_backup_cannot_smuggle_undecodable_custom_background(self):
        item = self.upload()
        before = self.library()
        def corrupt_resource(files):
            manifest = json.loads(files['manifest.json'])
            files[manifest['resources'][item['path']]] = b'not a real PNG'
        malformed = self.alter_backup(self.client.get('/api/backup').data, mutate_files=corrupt_resource)
        error = self.restore(malformed, expected=400)
        self.assertEqual(error['code'], 'invalid_image')
        self.assertEqual(self.library()['backgrounds'], before['backgrounds'])
        self.assertEqual(self.library()['state'], before['state'])
        self.assertFalse((self.root / 'instance/backups').exists())

    def test_host_csrf_and_origin(self):
        self.assertEqual(self.client.get('/api/library', headers={'Host': 'evil.example'}).status_code, 403)
        self.assertEqual(self.client.post('/api/categories', json={'name': '注入'}).status_code, 403)
        response = self.client.post('/api/categories', json={'name': '注入'}, headers={'X-CSRF-Token': self.token, 'Origin': 'https://evil.example'})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.post('/api/categories', json={'name': '注入'}, headers={'X-CSRF-Token': 'é'}).status_code, 403)
        self.assertEqual(len(self.library()['categories']), 3)
        health = self.client.get('/api/health').get_json()
        self.assertEqual(health['app'], 'content-workbench')
        self.assertEqual(health['version'], '0.1.0')
        self.assertEqual(Path(health['data_dir']), self.root / 'instance')

    def test_seed_once_and_source_fields_immutable(self):
        self.write('/api/scripts/script-a', {'title': '自行改名', 'source_category': '伪造', 'source_pages': [99]}, method='PATCH')
        library = create_app(self.config).test_client().get('/api/library').get_json()
        script = next(item for item in library['scripts'] if item['id'] == 'script-a')
        self.assertEqual(script['title'], '自行改名')
        self.assertEqual(script['source_category'], '甜本')
        self.assertEqual(script['source_pages'], [7, 8])

    def test_preview_and_edit_do_not_publish_or_pause(self):
        state = self.apply_script()
        playing = self.write('/api/command', {'action': 'play'})
        self.write('/api/scripts/script-a', {'title': '编辑中的标题'}, method='PATCH')
        preview = self.write('/api/preview', {'mode': 'script', 'script_id': 'script-a', 'orientation': 'landscape', 'layout': {'font_size': 45}})
        current = self.client.get('/api/state').get_json()
        self.assertEqual(preview['scripts'][0]['title'], '编辑中的标题')
        self.assertEqual(current, playing)
        self.assertEqual(current['snapshot']['scripts'][0]['title'], '示例条目')
        self.assertEqual(current['snapshot']['id'], state['snapshot']['id'])

    def test_verified_preview_rejects_unseen_edits_without_changing_live(self):
        before = self.apply_script()
        payload = {'mode': 'script', 'script_id': 'script-a', 'orientation': 'portrait'}
        preview = self.write('/api/preview', payload)
        repeated = self.write('/api/preview', payload)
        self.assertNotEqual(preview['id'], repeated['id'])
        self.assertEqual(preview['content_token'], repeated['content_token'])
        self.write('/api/scripts/script-a', {'title': '预览后被另一页面改名'}, method='PATCH')
        failure = self.write('/api/apply', {**payload, 'preview_token': preview['content_token']}, expected=409)
        self.assertEqual(failure['code'], 'preview_stale')
        self.assertEqual(self.client.get('/api/state').get_json(), before)
        renewed = self.write('/api/preview', payload)
        self.assertNotEqual(renewed['content_token'], preview['content_token'])
        published = self.write('/api/apply', {**payload, 'preview_token': renewed['content_token']})
        self.assertEqual(published['snapshot']['scripts'][0]['title'], '预览后被另一页面改名')

    def test_preview_anchor_applies_candidate_and_position_atomically(self):
        self.apply_script('script-b')
        before = self.write('/api/command', {'action': 'play'})
        payload = {'mode': 'script', 'script_id': 'script-a', 'orientation': 'landscape',
                   'layout': {'font_size': 46}, 'preview_anchor': 'para-2'}
        preview = self.write('/api/preview', payload)
        self.assertEqual(self.client.get('/api/state').get_json(), before)
        self.assertNotEqual(self.library()['layouts']['landscape']['font_size'], 46)
        published = self.write('/api/apply', {**payload, 'preview_token': preview['content_token']})
        self.assertEqual(published['snapshot']['scripts'][0]['id'], 'script-a')
        self.assertEqual(published['anchor'], 'para-2')
        self.assertFalse(published['playing'])
        self.assertEqual(published['revision'], before['revision'] + 1)
        self.assertEqual(published['seek_version'], before['seek_version'] + 1)
        self.assertEqual(self.library()['layouts']['landscape']['font_size'], 46)

    def test_invalid_preview_anchor_rolls_back_state_and_layout(self):
        self.apply_script('script-b')
        self.write('/api/command', {'action': 'play'})
        before = self.library()
        payload = {'mode': 'script', 'script_id': 'script-a', 'orientation': 'landscape',
                   'layout': {'font_size': 48}}
        preview = self.write('/api/preview', payload)
        # This ID belongs to the old live script, never to the new candidate.
        error = self.write('/api/apply', {**payload, 'preview_token': preview['content_token'],
                                         'preview_anchor': 'other-1'}, expected=409)
        self.assertEqual(error['code'], 'invalid_anchor')
        after = self.library()
        self.assertEqual(after['state'], before['state'])
        self.assertEqual(after['layouts'], before['layouts'])

    def test_optional_preview_anchor_keeps_legacy_rules_and_explicit_top(self):
        self.apply_script()
        self.write('/api/command', {'action': 'seek', 'anchor': 'para-2'})
        retained = self.apply_script(orientation='landscape')
        self.assertEqual(retained['anchor'], 'para-2')
        top = self.apply_script(orientation='landscape', preview_anchor=None)
        self.assertIsNone(top['anchor'])
        self.assertFalse(top['playing'])
        self.write('/api/command', {'action': 'seek', 'anchor': 'para-2'})
        switched = self.apply_script('script-b')
        self.assertIsNone(switched['anchor'])

    def test_realtime_position_and_playback_sync_reuses_snapshot(self):
        initial = self.apply_script()
        payload = {'mode': 'script', 'script_id': 'script-a', 'orientation': 'portrait'}
        preview = self.write('/api/preview', payload)
        sync = self.write('/api/apply', {**payload, 'preview_token': preview['content_token'],
                                        'realtime': True, 'preview_anchor': 'para-2', 'preview_playing': True})
        self.assertEqual(sync['snapshot']['id'], initial['snapshot']['id'])
        self.assertEqual(sync['snapshot']['created_at'], initial['snapshot']['created_at'])
        self.assertEqual(sync['anchor'], 'para-2')
        self.assertTrue(sync['playing'])
        self.assertEqual(sync['speed'], preview['layout']['speed'])
        self.assertEqual(sync['revision'], initial['revision'] + 1)
        self.assertEqual(sync['seek_version'], initial['seek_version'] + 1)
        stopped = self.write('/api/apply', {**payload, 'preview_token': preview['content_token'],
                                           'realtime': True, 'preview_anchor': None, 'preview_playing': False})
        self.assertEqual(stopped['snapshot']['id'], initial['snapshot']['id'])
        self.assertIsNone(stopped['anchor'])
        self.assertFalse(stopped['playing'])
        self.assertEqual(stopped['revision'], sync['revision'] + 1)

    def test_realtime_content_and_layout_changes_create_new_snapshot(self):
        initial = self.apply_script()
        self.write('/api/scripts/script-a', {'title': '实时模式的新内容'}, method='PATCH')
        payload = {'mode': 'script', 'script_id': 'script-a', 'orientation': 'portrait'}
        preview = self.write('/api/preview', payload)
        changed = self.write('/api/apply', {**payload, 'preview_token': preview['content_token'],
                                           'realtime': True, 'preview_anchor': 'para-2', 'preview_playing': True})
        self.assertNotEqual(changed['snapshot']['id'], initial['snapshot']['id'])
        self.assertEqual(changed['snapshot']['scripts'][0]['title'], '实时模式的新内容')
        self.assertEqual(changed['anchor'], 'para-2')
        self.assertTrue(changed['playing'])
        payload.update(orientation='landscape', layout={'font_size': 48, 'speed': 55})
        preview = self.write('/api/preview', payload)
        layout_changed = self.write('/api/apply', {**payload, 'preview_token': preview['content_token'],
                                                  'realtime': True, 'preview_anchor': 'para-1', 'preview_playing': False})
        self.assertNotEqual(layout_changed['snapshot']['id'], changed['snapshot']['id'])
        self.assertEqual(layout_changed['orientation'], 'landscape')
        self.assertEqual(layout_changed['snapshot']['layout']['font_size'], 48)
        self.assertEqual(layout_changed['speed'], 55)
        self.assertEqual(layout_changed['anchor'], 'para-1')
        self.assertFalse(layout_changed['playing'])

    def test_realtime_stale_token_and_invalid_anchor_leave_state_unchanged(self):
        self.apply_script()
        self.write('/api/command', {'action': 'play'})
        payload = {'mode': 'script', 'script_id': 'script-a', 'orientation': 'landscape',
                   'layout': {'font_size': 49}, 'realtime': True, 'preview_playing': False}
        preview = self.write('/api/preview', payload)
        self.write('/api/scripts/script-a', {'title': '预览后的再次变动'}, method='PATCH')
        before = self.library()
        error = self.write('/api/apply', {**payload, 'preview_token': preview['content_token'],
                                         'preview_anchor': 'para-2'}, expected=409)
        self.assertEqual(error['code'], 'preview_stale')
        fresh = self.write('/api/preview', payload)
        error = self.write('/api/apply', {**payload, 'preview_token': fresh['content_token'],
                                         'preview_anchor': 'other-1'}, expected=409)
        self.assertEqual(error['code'], 'invalid_anchor')
        after = self.library()
        self.assertEqual(after['state'], before['state'])
        self.assertEqual(after['layouts'], before['layouts'])

    def test_apply_playback_flags_require_boolean_and_verified_preview(self):
        self.apply_script()
        before = self.library()
        payload = {'mode': 'script', 'script_id': 'script-a', 'orientation': 'portrait'}
        preview = self.write('/api/preview', payload)
        for field in ('preview_playing', 'realtime'):
            for value in (0, 1, 'false', None, [], {}):
                with self.subTest(field=field, value=value):
                    self.write('/api/apply', {**payload, 'preview_token': preview['content_token'], field: value}, expected=400)
        for flags in ({'preview_playing': False}, {'preview_playing': True}, {'realtime': True}):
            error = self.write('/api/apply', {**payload, **flags}, expected=400)
            self.assertEqual(error['code'], 'preview_required')
        self.assertEqual(self.library()['state'], before['state'])
        self.assertEqual(self.library()['layouts'], before['layouts'])

    def test_confirmation_still_pauses_and_empty_realtime_cannot_play(self):
        payload = {'mode': 'script', 'script_id': 'script-a', 'orientation': 'portrait', 'layout': {'body_mode': 'scroll'}}
        preview = self.write('/api/preview', payload)
        playing = self.write('/api/apply', {**payload, 'preview_token': preview['content_token'], 'preview_playing': True})
        self.assertTrue(playing['playing'])
        confirmed = self.write('/api/apply', {**payload, 'preview_token': preview['content_token']})
        self.assertFalse(confirmed['playing'])
        self.assertNotEqual(confirmed['snapshot']['id'], playing['snapshot']['id'])
        empty_payload = {'mode': 'list', 'list_source': 'queue', 'script_ids': []}
        empty_preview = self.write('/api/preview', empty_payload)
        before = self.library()
        error = self.write('/api/apply', {**empty_payload, 'preview_token': empty_preview['content_token'],
                                         'realtime': True, 'preview_playing': True}, expected=400)
        self.assertEqual(error['code'], 'empty_display')
        self.assertEqual(self.library()['state'], before['state'])
        self.assertEqual(self.library()['layouts'], before['layouts'])

    def test_checkpoint_no_command_reissue_and_stale_rejected(self):
        state = self.apply_script()
        checked = self.write('/api/checkpoint', {'revision': state['revision'], 'anchor': 'para-2'})
        self.assertEqual(checked['revision'], state['revision'])
        self.assertEqual(checked['seek_version'], state['seek_version'])
        paused = self.write('/api/command', {'action': 'pause', 'anchor': 'para-1'})
        self.assertEqual(paused['anchor'], 'para-2')
        self.assertEqual(paused['seek_version'], state['seek_version'])
        self.write('/api/checkpoint', {'revision': state['revision'], 'anchor': 'para-1'}, expected=409)
        self.assertEqual(self.client.get('/api/state').get_json()['anchor'], 'para-2')
        seek = self.write('/api/command', {'action': 'seek', 'anchor': 'para-1'})
        self.assertEqual(seek['seek_version'], state['seek_version'] + 1)

    def test_new_default_layouts_and_missing_mode_prefer_pages(self):
        before = self.library()
        for orientation in ('portrait', 'landscape'):
            self.assertEqual(before['default_layouts'][orientation]['body_mode'], 'pages')
            self.assertEqual(before['layouts'][orientation]['body_mode'], 'pages')
            preview = self.write('/api/preview', {'mode': 'script', 'script_id': 'script-a', 'orientation': orientation})
            self.assertEqual(preview['layout']['body_mode'], 'pages')
        preset = self.write('/api/layout-presets', {'name': '使用新默认', 'layouts': {'portrait': {}, 'landscape': {}}}, expected=201)
        self.assertTrue(all(layout['body_mode'] == 'pages' for layout in preset['layouts'].values()))
        self.assertEqual(self.library()['state'], before['state'])
        state = self.write('/api/apply', {'mode': 'script', 'script_id': 'script-a'})
        self.assertEqual(state['snapshot']['layout']['body_mode'], 'pages')
        self.assertEqual(state['page_index'], 0)
        self.write('/api/command', {'action': 'play'}, expected=400)

    def test_explicit_scroll_media_and_presets_survive_default_change(self):
        live = self.apply_script(preview_anchor='para-2')
        preset = self.write('/api/layout-presets', {'name': '自定义既有选择', 'layouts': {
            'portrait': {'body_mode': 'scroll', 'font_size': 47},
            'landscape': {'body_mode': 'media', 'media_side': 'right'}}}, expected=201)
        for orientation, mode in [('portrait', 'scroll'), ('landscape', 'media')]:
            self.write('/api/layouts', {'orientation': orientation, 'layout': {'body_mode': mode}})
            saved = self.write('/api/layouts', {'orientation': orientation, 'layout': {'font_size': 52}})
            self.assertEqual(saved[orientation]['body_mode'], mode)
        loaded = self.library()
        self.assertEqual(loaded['state'], live)
        self.assertEqual(loaded['layout_presets'], [preset])
        # The maintenance operation changes only future drafts, never live or presets.
        for orientation in ('portrait', 'landscape'):
            self.write('/api/layouts', {'orientation': orientation, 'layout': {'body_mode': 'pages'}})
        after = self.library()
        self.assertEqual(after['state'], live)
        self.assertEqual(after['layout_presets'], [preset])
        self.assertTrue(all(layout['font_size'] == 52 for layout in after['layouts'].values()))

    def test_legacy_snapshot_missing_mode_stays_scroll_without_read_side_effects(self):
        self.apply_script(preview_anchor='para-2')
        legacy = self.write('/api/command', {'action': 'play'})
        legacy['snapshot']['layout'].pop('body_mode')
        store = self.app.extensions['store']
        with store.transaction(write=True) as connection:
            store._save_setting(connection, 'state', legacy)
        with store.transaction() as connection:
            raw_before = dict(connection.execute('SELECT key,data FROM settings'))
        loaded = self.library()['state']
        self.assertEqual(loaded['snapshot']['layout']['body_mode'], 'scroll')
        self.assertTrue(loaded['playing'])
        for field in ('revision', 'seek_version', 'anchor', 'page_index'):
            self.assertEqual(loaded[field], legacy[field])
        self.assertEqual(loaded['snapshot']['id'], legacy['snapshot']['id'])
        self.assertEqual(loaded['snapshot']['content_token'], legacy['snapshot']['content_token'])
        with store.transaction() as connection:
            self.assertEqual(dict(connection.execute('SELECT key,data FROM settings')), raw_before)
        restarted = create_app(self.config).extensions['store'].state()
        self.assertEqual(restarted['snapshot']['layout']['body_mode'], 'scroll')
        self.assertEqual(restarted['snapshot']['id'], legacy['snapshot']['id'])
        self.assertEqual(restarted['anchor'], 'para-2')
        self.assertFalse(restarted['playing'])

    def test_old_backup_defaults_do_not_reinterpret_live_or_explicit_presets(self):
        live = self.apply_script(preview_anchor='para-2')
        preset = self.write('/api/layout-presets', {'name': '旧方案保留', 'layouts': {
            'portrait': {'body_mode': 'scroll'}, 'landscape': {'body_mode': 'media'}}}, expected=201)
        self.write('/api/scripts/script-a', {'title': '留有修改历史'}, method='PATCH')
        backup = self.client.get('/api/backup').data
        def missing_mode(connection):
            state = json.loads(connection.execute("SELECT data FROM settings WHERE key='state'").fetchone()[0])
            state['snapshot']['layout'].pop('body_mode')
            connection.execute("UPDATE settings SET data=? WHERE key='state'", (json.dumps(state),))
            layouts = json.loads(connection.execute("SELECT data FROM settings WHERE key='layouts'").fetchone()[0])
            layouts['portrait'].pop('body_mode')
            layouts['landscape']['body_mode'] = 'media'
            connection.execute("UPDATE settings SET data=? WHERE key='layouts'", (json.dumps(layouts),))
        self.restore(self.alter_backup(backup, missing_mode))
        current = self.library()
        self.assertEqual(current['layouts']['portrait']['body_mode'], 'pages')
        self.assertEqual(current['layouts']['landscape']['body_mode'], 'media')
        self.assertEqual(current['layout_presets'], [preset])
        self.assertEqual(current['state']['snapshot']['layout']['body_mode'], 'scroll')
        self.assertEqual(current['state']['snapshot']['id'], live['snapshot']['id'])
        self.assertEqual(current['state']['anchor'], 'para-2')
        self.assertFalse(current['state']['playing'])
        history = self.client.get('/api/scripts/script-a/history').get_json()['history']
        self.assertEqual(history[0]['script']['title'], '示例条目')
        self.assertEqual(history[0]['script']['blocks'][0]['text'], '甲：第一句。')

    def test_layout_presets_crud_isolated_from_saved_layout_and_live(self):
        self.apply_script(preview_anchor='para-2')
        before = self.library()
        preset = self.write('/api/layout-presets', {'name': '我的分页样式', 'layouts': {
            'portrait': {'font_size': 48, 'body_mode': 'pages', 'category_columns': 2},
            'landscape': {'font_size': 30, 'category_background_opacity': 0.4}}}, expected=201)
        self.assertEqual(preset['layouts']['portrait']['body_mode'], 'pages')
        self.assertEqual(preset['layouts']['landscape']['body_mode'], 'pages')
        self.assertEqual(set(preset['layouts']['portrait']), set(before['default_layouts']['portrait']))
        updated = self.write('/api/layout-presets/' + preset['id'], {'name': '重命名'}, method='PATCH')
        self.assertEqual(updated['layouts'], preset['layouts'])
        overwritten = self.write('/api/layout-presets/' + preset['id'], {'layouts': {'portrait': {}, 'landscape': {'body_mode': 'pages'}}}, method='PATCH')
        self.assertEqual(overwritten['layouts']['portrait'], before['default_layouts']['portrait'])
        self.assertEqual(overwritten['layouts']['landscape']['body_mode'], 'pages')
        listed = self.client.get('/api/layout-presets').get_json()
        self.assertEqual(listed['layout_presets'], [overwritten])
        self.assertEqual(listed['default_layouts'], before['default_layouts'])
        self.write('/api/layout-presets/' + preset['id'], method='DELETE')
        after = self.library()
        self.assertEqual(after['layout_presets'], [])
        self.assertEqual(after['layouts'], before['layouts'])
        self.assertEqual(after['state'], before['state'])
        self.assertEqual(after['default_layouts'], before['default_layouts'])
        self.write('/api/layout-presets/default', {'name': '改默认'}, method='PATCH', expected=404)
        self.write('/api/layout-presets/default', method='DELETE', expected=404)

    def test_layout_presets_validate_payload_uniqueness_and_limit(self):
        before = self.library()
        for payload in ({}, {'name': '缺两画幅'}, {'name': '只一方向', 'layouts': {'portrait': {}}},
                        {'name': '  ', 'layouts': {'portrait': {}, 'landscape': {}}},
                        {'name': '非法字段', 'layouts': {'portrait': {}, 'landscape': {}}, 'id': 'custom'},
                        {'name': '非法样式', 'layouts': {'portrait': {'body_mode': 'video'}, 'landscape': {}}}):
            self.write('/api/layout-presets', payload, expected=400)
        self.assertEqual(self.library()['layout_presets'], [])
        self.write('/api/layout-presets', {'name': '同名', 'layouts': before['layouts']}, expected=201)
        duplicate = self.write('/api/layout-presets', {'name': ' 同名 ', 'layouts': before['layouts']}, expected=409)
        self.assertEqual(duplicate['code'], 'duplicate_preset')
        for index in range(9):
            self.write('/api/layout-presets', {'name': '排版' + str(index), 'layouts': before['layouts']}, expected=201)
        limit = self.write('/api/layout-presets', {'name': '第十一套', 'layouts': before['layouts']}, expected=409)
        self.assertEqual(limit['code'], 'preset_limit')
        self.assertEqual(len(self.library()['layout_presets']), 10)
        self.assertEqual(self.library()['layouts'], before['layouts'])
        self.assertEqual(self.library()['state'], before['state'])

    def test_layout_presets_backup_roundtrip_old_compatibility_and_validation(self):
        preset = self.write('/api/layout-presets', {'name': '备份预设', 'layouts': {
            'portrait': {'body_mode': 'pages'}, 'landscape': {'font_size': 51}}}, expected=201)
        self.apply_script()
        backup = self.client.get('/api/backup').data
        self.write('/api/layout-presets/' + preset['id'], method='DELETE')
        self.restore(backup)
        self.assertEqual(self.library()['layout_presets'], [preset])
        before = self.library()
        def corrupt(connection):
            entries = json.loads(connection.execute("SELECT data FROM settings WHERE key='layout_presets'").fetchone()[0])
            entries[0]['layouts']['portrait']['body_mode'] = 'unknown'
            connection.execute("UPDATE settings SET data=? WHERE key='layout_presets'", (json.dumps(entries),))
        self.restore(self.alter_backup(backup, corrupt), expected=400)
        self.assertEqual(self.library()['layout_presets'], before['layout_presets'])
        self.assertEqual(self.library()['state'], before['state'])
        def old(connection):
            connection.execute("DELETE FROM settings WHERE key='layout_presets'")
            for key in ('layouts', 'state'):
                value = json.loads(connection.execute('SELECT data FROM settings WHERE key=?', (key,)).fetchone()[0])
                layouts = value.values() if key == 'layouts' else [value['snapshot']['layout']]
                for layout in layouts:
                    layout.pop('body_mode', None)
                if key == 'state':
                    value.pop('page_index', None)
                connection.execute('UPDATE settings SET data=? WHERE key=?', (json.dumps(value), key))
        self.restore(self.alter_backup(backup, old))
        current = self.library()
        self.assertEqual(current['layout_presets'], [])
        self.assertEqual(current['state']['snapshot']['layout']['body_mode'], 'scroll')
        self.assertIsNone(current['state']['page_index'])

    def test_import_preview_json_txt_docx_are_readonly_and_candidate_can_be_saved(self):
        from test_import_parser import docx
        source = '剧名：导入的本\r\n作者：原作者\r\n\r\n \t \n　\n小甲：你好。\n旁白：夜深了。\n未指定角色原文'
        expected_text = '剧名：导入的本\r\n作者：原作者\r\n小甲：你好。\n旁白：夜深了。\n未指定角色原文'
        self.apply_script()
        self.write('/api/command', {'action': 'play'})
        store = self.app.extensions['store']
        with store.transaction() as connection:
            before = store._export(connection)
        result = self.write('/api/import-preview', {'text': source})
        self.assertEqual(result['candidate']['title'], '导入的本')
        self.assertEqual(result['roles'], ['小甲', '旁白'])
        self.assertEqual(''.join(block['text'] for block in result['candidate']['blocks']), expected_text)
        self.assertEqual(result['candidate']['source_text'], source)
        self.assertEqual(len(result['candidate']['blocks']), 5)
        self.assertTrue(any('已跳过 3 个纯空行' in warning for warning in result['warnings']))
        document = docx('<w:p/><w:p><w:r><w:t xml:space="preserve"> </w:t><w:tab/></w:r></w:p>'
                        '<w:p><w:r><w:t>　</w:t></w:r></w:p><w:p><w:r><w:t>甲：DOCX正文</w:t></w:r></w:p>')
        for content, filename, original, expected in [(source.encode('gb18030'), '角色本.txt', source, expected_text),
                                                      (document, '稿.docx', '\n \t\n　\n甲：DOCX正文', '甲：DOCX正文')]:
            response = self.client.post('/api/import-preview', data={'file': (io.BytesIO(content), filename)},
                                        headers={'X-CSRF-Token': self.token})
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
            imported = response.get_json()
            self.assertEqual(imported['candidate']['source_text'], original)
            self.assertEqual(''.join(block['text'] for block in imported['candidate']['blocks']), expected)
            self.assertTrue(all(block['text'].strip() for block in imported['candidate']['blocks']))
            self.assertTrue(any('已跳过 3 个纯空行' in warning for warning in imported['warnings']))
            response.close()
            response.request.close()
            response.request.environ['wsgi.input'].close()
        self.write('/api/import-preview', {'text': ''}, expected=400)
        malformed = self.client.post('/api/import-preview', data={'file': (io.BytesIO(b'not docx'), 'broken.docx')}, headers={'X-CSRF-Token': self.token})
        self.assertEqual(malformed.status_code, 400)
        with store.transaction() as connection:
            self.assertEqual(store._export(connection), before)
        candidate = result['candidate']
        saved = self.write('/api/scripts', {'title': candidate['title'], 'author': candidate['author'],
                                            'category_id': 'cat-a', 'blocks': candidate['blocks']}, expected=201)
        self.assertEqual(''.join(block['text'] for block in saved['blocks']), expected_text)
        self.assertEqual([block['role'] for block in saved['blocks']], [block['role'] for block in candidate['blocks']])

    def test_body_pages_token_pause_and_directory_play_is_unchanged(self):
        payload = {'mode': 'script', 'script_id': 'script-a', 'layout': {'body_mode': 'pages'}}
        preview = self.write('/api/preview', payload)
        scroll = self.write('/api/preview', {**payload, 'layout': {'body_mode': 'scroll'}})
        self.assertNotEqual(preview['content_token'], scroll['content_token'])
        state = self.write('/api/apply', {**payload, 'preview_token': preview['content_token'], 'preview_playing': True})
        self.assertFalse(state['playing'])
        self.assertEqual(state['page_index'], 0)
        self.assertIn('分页', state['notice'])
        error = self.write('/api/command', {'action': 'play'}, expected=400)
        self.assertEqual(error['code'], 'paged_display')
        self.assertEqual(self.library()['state'], state)
        self.write('/api/apply', {'mode': 'list', 'directory_level': 'categories', 'layout': {'body_mode': 'pages'}})
        self.assertTrue(self.write('/api/command', {'action': 'play'})['playing'])
        for value in ('video', None, True, [], 0):
            self.write('/api/preview', {'mode': 'script', 'script_id': 'script-a', 'layout': {'body_mode': value}}, expected=400)

    def test_verified_page_apply_preserves_exact_page_and_reuses_content(self):
        payload = {'mode': 'script', 'script_id': 'script-a', 'layout': {'body_mode': 'pages'}}
        preview = self.write('/api/preview', payload)
        state = self.write('/api/apply', {**payload, 'preview_token': preview['content_token'],
                                         'preview_page_index': 3, 'preview_anchor': 'para-2'})
        self.assertEqual(state['page_index'], 3)
        self.assertEqual(state['anchor'], 'para-2')
        synced = self.write('/api/apply', {**payload, 'preview_token': preview['content_token'], 'realtime': True})
        self.assertEqual(synced['page_index'], 3)
        self.assertEqual(synced['snapshot']['id'], state['snapshot']['id'])
        changed_layout = {**payload, 'layout': {'body_mode': 'pages', 'font_size': 50}}
        preview_layout = self.write('/api/preview', changed_layout)
        recompute = self.write('/api/apply', {**changed_layout, 'preview_token': preview_layout['content_token']})
        self.assertIsNone(recompute['page_index'])
        self.assertEqual(recompute['anchor'], 'para-2')
        exact = self.write('/api/apply', {**changed_layout, 'preview_token': preview_layout['content_token'],
                                         'preview_anchor': 'para-2', 'preview_page_index': 5})
        self.assertEqual(exact['page_index'], 5)
        seek = self.write('/api/command', {'action': 'seek', 'anchor': 'para-1'})
        self.assertIsNone(seek['page_index'])
        other_script = self.write('/api/apply', {'mode': 'script', 'script_id': 'script-b',
                                               'layout': {'body_mode': 'pages', 'font_size': 40}})
        self.assertEqual(other_script['page_index'], 0)
        self.assertIsNone(other_script['anchor'])

    def test_invalid_page_apply_rolls_back_live_and_layout(self):
        self.apply_script()
        before = self.library()
        payload = {'mode': 'script', 'script_id': 'script-a', 'layout': {'body_mode': 'pages'}}
        preview = self.write('/api/preview', payload)
        self.write('/api/apply', {**payload, 'preview_page_index': 1}, expected=400)
        for value in (-1, 100001, 1.5, 1.0, True, None, '2'):
            self.write('/api/apply', {**payload, 'preview_token': preview['content_token'], 'preview_page_index': value}, expected=400)
        self.write('/api/apply', {**payload, 'preview_token': 'stale', 'preview_page_index': 1}, expected=409)
        nonpages = {'mode': 'list', 'directory_level': 'categories'}
        other = self.write('/api/preview', nonpages)
        self.write('/api/apply', {**nonpages, 'preview_token': other['content_token'], 'preview_page_index': 1}, expected=400)
        self.assertEqual(self.library()['state'], before['state'])
        self.assertEqual(self.library()['layouts'], before['layouts'])

    def test_page_command_checkpoint_backup_and_stale_snapshot_protection(self):
        payload = {'mode': 'script', 'script_id': 'script-a', 'layout': {'body_mode': 'pages'}}
        state = self.write('/api/apply', payload)
        command = {'action': 'page', 'snapshot_id': state['snapshot']['id'], 'page_index': 2, 'anchor': 'para-1'}
        moved = self.write('/api/command', command)
        self.assertEqual(moved['page_index'], 2)
        self.assertEqual(moved['seek_version'], state['seek_version'] + 1)
        checkpoint = self.write('/api/checkpoint', {'revision': moved['revision'], 'page_index': 3, 'anchor': 'para-1'})
        self.assertEqual(checkpoint['page_index'], 3)
        self.assertEqual(checkpoint['seek_version'], moved['seek_version'])
        self.assertEqual(checkpoint['revision'], moved['revision'])
        self.write('/api/command', {**command, 'snapshot_id': 'old'}, expected=409)
        self.write('/api/command', {**command, 'anchor': 'invalid'}, expected=409)
        self.write('/api/command', {**command, 'page_index': -1}, expected=400)
        self.write('/api/checkpoint', {'revision': moved['revision'], 'page_index': True, 'anchor': 'para-1'}, expected=400)
        self.assertEqual(self.library()['state'], checkpoint)
        backup = self.client.get('/api/backup').data
        self.restore(backup)
        restored = self.library()['state']
        self.assertEqual(restored['page_index'], 3)
        self.assertEqual(restored['anchor'], 'para-1')
        self.assertFalse(restored['playing'])
        def malformed(connection):
            value = json.loads(connection.execute("SELECT data FROM settings WHERE key='state'").fetchone()[0])
            value['page_index'] = -4
            connection.execute("UPDATE settings SET data=? WHERE key='state'", (json.dumps(value),))
        self.restore(self.alter_backup(backup, malformed), expected=400)
        self.assertEqual(self.library()['state'], restored)

    def test_category_layout_fields_are_independent_per_orientation(self):
        initial = self.library()
        for orientation in ('portrait', 'landscape'):
            self.assertEqual(initial['layouts'][orientation]['category_columns'], 0)
            self.assertEqual(initial['layouts'][orientation]['category_background_opacity'], 0.8)
        self.write('/api/layouts', {'orientation': 'portrait', 'layout': {
            'category_columns': 2, 'category_background_opacity': 0.45}}, method='PATCH')
        layouts = self.write('/api/layouts', {'orientation': 'landscape', 'layout': {
            'category_columns': 4, 'category_background_opacity': 1}}, method='PATCH')
        self.assertEqual(layouts['portrait']['category_columns'], 2)
        self.assertEqual(layouts['portrait']['category_background_opacity'], 0.45)
        self.assertEqual(layouts['landscape']['category_columns'], 4)
        self.assertEqual(layouts['landscape']['category_background_opacity'], 1)
        before = self.library()
        preview = self.write('/api/preview', {'mode': 'list', 'directory_level': 'categories',
                                              'layout': {'category_columns': 1, 'category_background_opacity': 0}})
        self.assertEqual(preview['layout']['category_columns'], 1)
        self.assertEqual(preview['layout']['category_background_opacity'], 0)
        self.assertEqual(self.library()['layouts'], before['layouts'])
        self.assertEqual(self.library()['state'], before['state'])

    def test_category_layout_invalid_values_never_change_live_or_saved_layout(self):
        self.write('/api/apply', {'mode': 'list', 'directory_level': 'categories', 'preview_anchor': 'category:cat-a'})
        before = self.library()
        for field, values in [('category_columns', [-1, 5, 2.0, 1.5, True, None, '2', []]),
                              ('category_background_opacity', [-0.1, 1.01, True, None, '0.8', {}])]:
            for value in values:
                with self.subTest(field=field, value=value):
                    layout = {field: value}
                    self.write('/api/layouts', {'orientation': 'portrait', 'layout': layout}, method='PATCH', expected=400)
                    self.write('/api/preview', {'mode': 'list', 'layout': layout}, expected=400)
                    self.write('/api/apply', {'mode': 'list', 'orientation': 'landscape', 'layout': layout}, expected=400)
        self.assertEqual(self.library()['layouts'], before['layouts'])
        self.assertEqual(self.library()['state'], before['state'])

    def test_category_layout_changes_affect_preview_token_and_snapshot_reuse(self):
        payload = {'mode': 'list', 'directory_level': 'categories', 'list_source': 'categories'}
        preview = self.write('/api/preview', payload)
        initial = self.write('/api/apply', {**payload, 'preview_token': preview['content_token'],
                                           'preview_anchor': 'category:cat-b'})
        self.write('/api/layouts', {'orientation': 'portrait', 'layout': {'category_columns': 3}}, method='PATCH')
        error = self.write('/api/apply', {**payload, 'preview_token': preview['content_token']}, expected=409)
        self.assertEqual(error['code'], 'preview_stale')
        self.assertEqual(self.library()['state'], initial)
        changed_preview = self.write('/api/preview', payload)
        self.assertNotEqual(changed_preview['content_token'], preview['content_token'])
        changed = self.write('/api/apply', {**payload, 'preview_token': changed_preview['content_token'], 'realtime': True})
        self.assertNotEqual(changed['snapshot']['id'], initial['snapshot']['id'])
        self.assertEqual(changed['anchor'], 'category:cat-b')
        same = self.write('/api/apply', {**payload, 'preview_token': changed_preview['content_token'], 'realtime': True})
        self.assertEqual(same['snapshot']['id'], changed['snapshot']['id'])
        opacity_preview = self.write('/api/preview', {**payload, 'layout': {'category_background_opacity': 0.3}})
        self.assertNotEqual(opacity_preview['content_token'], changed_preview['content_token'])
        self.assertEqual(opacity_preview['scripts'], changed_preview['scripts'])
        self.assertEqual(opacity_preview['selection'], changed_preview['selection'])

    def test_old_layout_and_snapshot_defaults_are_read_only_and_restore_compatible(self):
        state = self.apply_script(preview_anchor='para-2')
        store = self.app.extensions['store']
        with store.transaction(write=True) as connection:
            layouts = store._setting(connection, 'layouts')
            for layout in [*layouts.values(), state['snapshot']['layout']]:
                layout.pop('category_columns')
                layout.pop('category_background_opacity')
            store._save_setting(connection, 'layouts', layouts)
            store._save_setting(connection, 'state', state)
        with store.transaction() as connection:
            raw_before = dict(connection.execute('SELECT key,data FROM settings'))
        loaded = self.library()
        direct_state = self.client.get('/api/state').get_json()
        self.assertEqual(loaded['state'], direct_state)
        self.assertEqual(direct_state['snapshot']['layout']['category_columns'], 0)
        self.assertEqual(direct_state['snapshot']['layout']['category_background_opacity'], 0.8)
        self.assertEqual(direct_state['snapshot']['scripts'], state['snapshot']['scripts'])
        self.assertEqual(direct_state['snapshot']['selection'], state['snapshot']['selection'])
        self.assertEqual(direct_state['snapshot']['id'], state['snapshot']['id'])
        self.assertEqual(direct_state['anchor'], 'para-2')
        self.assertEqual(direct_state['revision'], state['revision'])
        self.assertEqual(direct_state['seek_version'], state['seek_version'])
        for layout in loaded['layouts'].values():
            self.assertEqual(layout['category_columns'], 0)
            self.assertEqual(layout['category_background_opacity'], 0.8)
        with store.transaction() as connection:
            self.assertEqual(dict(connection.execute('SELECT key,data FROM settings')), raw_before)
        self.restore(self.client.get('/api/backup').data)
        restored = self.library()
        self.assertEqual(restored['state']['anchor'], 'para-2')
        self.assertEqual(restored['state']['snapshot']['id'], state['snapshot']['id'])
        self.assertEqual(restored['state']['snapshot']['layout']['category_background_opacity'], 0.8)
        self.assertEqual(restored['layouts']['portrait']['category_columns'], 0)

    def test_category_layout_backup_round_trip_and_malformed_backup_rejected(self):
        state = self.write('/api/apply', {'mode': 'list', 'directory_level': 'categories',
                                         'layout': {'category_columns': 3, 'category_background_opacity': 0.25},
                                         'preview_anchor': 'category:cat-a'})
        self.write('/api/layouts', {'orientation': 'landscape', 'layout': {
            'category_columns': 4, 'category_background_opacity': 0.9}}, method='PATCH')
        backup = self.client.get('/api/backup').data
        self.restore(backup)
        restored = self.library()
        self.assertEqual(restored['layouts']['portrait']['category_columns'], 3)
        self.assertEqual(restored['layouts']['landscape']['category_columns'], 4)
        self.assertEqual(restored['layouts']['landscape']['category_background_opacity'], 0.9)
        self.assertEqual(restored['state']['snapshot']['layout']['category_background_opacity'], 0.25)
        self.assertEqual(restored['state']['anchor'], state['anchor'])
        for setting in ('layouts', 'state'):
            def invalid_layout(connection):
                value = json.loads(connection.execute('SELECT data FROM settings WHERE key=?', (setting,)).fetchone()[0])
                layout = value['portrait'] if setting == 'layouts' else value['snapshot']['layout']
                layout['category_columns'] = 9
                connection.execute('UPDATE settings SET data=? WHERE key=?', (json.dumps(value), setting))
            malformed = self.alter_backup(backup, invalid_layout)
            self.restore(malformed, expected=400)
            self.assertEqual(self.library()['state'], restored['state'])
            self.assertEqual(self.library()['layouts'], restored['layouts'])

    def test_direction_retains_anchor_and_layouts_independent(self):
        self.apply_script()
        self.write('/api/command', {'action': 'seek', 'anchor': 'para-2'})
        changed = self.apply_script(orientation='landscape', layout={'font_size': 46, 'speed': 50})
        self.assertEqual(changed['anchor'], 'para-2')
        self.assertFalse(changed['playing'])
        self.write('/api/command', {'action': 'speed', 'speed': 75})
        layouts = self.client.get('/api/layouts').get_json()
        self.assertEqual(layouts['landscape']['speed'], 50)
        self.assertEqual(layouts['portrait']['speed'], 28)
        self.assertEqual(layouts['landscape']['font_size'], 46)

    def test_deleted_anchor_fallback_and_source_history(self):
        self.apply_script()
        self.write('/api/command', {'action': 'seek', 'anchor': 'para-2'})
        script = next(item for item in self.library()['scripts'] if item['id'] == 'script-a')
        replacement = copy.deepcopy(script['blocks'][:1])
        replacement[0].update(text='甲：修改后的文字。', source_page=99, source_file='伪造.pptx')
        updated = self.write('/api/scripts/script-a', {'blocks': replacement}, method='PATCH')
        self.assertEqual(updated['blocks'][0]['source_page'], 7)
        self.assertEqual(updated['blocks'][0]['original_text'], '甲：第一句。')
        self.assertNotIn('runs', updated['blocks'][0])
        state = self.apply_script()
        self.assertIsNone(state['anchor'])
        self.assertIn('原定位已不存在', state['notice'])
        history = self.client.get('/api/scripts/script-a/history').get_json()['history']
        self.assertEqual(history[0]['script']['blocks'][1]['id'], 'para-2')

    def test_bad_runs_cannot_hide_actual_text(self):
        script = next(item for item in self.library()['scripts'] if item['id'] == 'script-a')
        script['blocks'][0]['runs'][0]['text'] = '被替换的台词'
        self.write('/api/scripts/script-a', {'blocks': script['blocks']}, method='PATCH', expected=400)
        self.assertEqual(self.library()['scripts'][0]['blocks'][0]['text'], '甲：第一句。')

    def test_hide_delete_does_not_mutate_snapshot(self):
        state = self.apply_script()
        self.write('/api/categories/cat-a', {'visible': False}, method='PATCH')
        self.write('/api/preview', {'mode': 'script', 'script_id': 'script-a'}, expected=409)
        self.assertEqual(self.client.get('/api/state').get_json(), state)
        self.write('/api/categories/cat-a', method='DELETE', expected=409)
        self.write('/api/categories/cat-a', {'target_id': 'cat-b'}, method='DELETE')
        self.assertEqual(self.client.get('/api/state').get_json(), state)
        script = next(item for item in self.library()['scripts'] if item['id'] == 'script-a')
        self.assertEqual(script['category_id'], 'cat-b')
        self.assertEqual(script['source_category'], '甜本')
        connected = self.write('/api/display/connect')
        self.assertEqual(connected['snapshot']['categories'][0]['id'], 'cat-a')
        self.assertFalse(connected['playing'])

    def test_transfer_validation_and_uncategorized(self):
        before = self.library()
        self.write('/api/categories/cat-a', {'target_id': 'missing'}, method='DELETE', expected=404)
        self.assertEqual(self.library()['scripts'], before['scripts'])
        self.write('/api/categories/uncategorized', method='DELETE', expected=400)
        self.write('/api/categories', {'name': ' 甜本 '}, expected=409)
        self.write('/api/categories', {'name': '  '}, expected=400)
        self.write('/api/categories/cat-a', {'target_id': 'uncategorized'}, method='DELETE')
        self.assertEqual(next(item for item in self.library()['categories'] if item['id'] == 'uncategorized')['script_count'], 1)

    def test_list_order_and_empty_queue(self):
        self.write('/api/queue', {'script_ids': ['script-b', 'script-a']}, method='PUT')
        state = self.write('/api/apply', {'mode': 'list', 'list_source': 'queue', 'script_ids': ['script-b', 'script-a']})
        self.assertIsNone(state['anchor'])
        self.assertEqual(state['snapshot']['scripts'][0]['id'], 'script-b')
        self.write('/api/command', {'action': 'seek', 'anchor': 'script:script-a'})
        state = self.write('/api/apply', {'mode': 'list', 'list_source': 'categories', 'category_ids': ['cat-b']})
        self.assertIsNone(state['anchor'])
        self.assertEqual(state['snapshot']['scripts'][0]['id'], 'script-b')
        empty = self.write('/api/apply', {'mode': 'list', 'list_source': 'queue', 'script_ids': []})
        self.assertEqual(empty['snapshot']['scripts'], [])
        self.assertIsNone(empty['anchor'])
        self.write('/api/command', {'action': 'play'}, expected=400)
        self.assertEqual(self.client.get('/api/queue').get_json()['script_ids'], ['script-b', 'script-a'])
        self.write('/api/categories/reorder', {'ids': ['cat-b', 'cat-a']})
        self.assertEqual(self.library()['categories'][0]['id'], 'cat-b')
        self.write('/api/categories/reorder', {'ids': ['cat-b']}, expected=409)

    def test_refresh_and_restart_pause_at_checkpoint(self):
        self.apply_script()
        playing = self.write('/api/command', {'action': 'play'})
        self.write('/api/checkpoint', {'revision': playing['revision'], 'anchor': 'para-2'})
        self.assertTrue(self.library()['state']['playing'])
        refresh = self.write('/api/display/connect')
        self.assertFalse(refresh['playing'])
        self.assertEqual(refresh['anchor'], 'para-2')
        self.write('/api/command', {'action': 'play'})
        restarted = create_app(self.config).test_client().get('/api/state').get_json()
        self.assertFalse(restarted['playing'])
        self.assertEqual(restarted['anchor'], 'para-2')

    def test_backup_restore_elsewhere_with_history_snapshot_and_images(self):
        self.apply_script()
        self.write('/api/command', {'action': 'seek', 'anchor': 'para-2'})
        self.write('/api/scripts/script-a', {'title': '备份中的标题'}, method='PATCH')
        backup = self.client.get('/api/backup')
        self.assertEqual(backup.status_code, 200)
        other_root = self.root / 'second-instance'
        other = create_app({**self.config, 'DATABASE': str(other_root / 'workbench.sqlite3'), 'INSTANCE_PATH': str(other_root)})
        client = other.test_client()
        token = client.get('/api/library').get_json()['csrf_token']
        response = client.post('/api/restore', data={'file': (io.BytesIO(backup.data), 'backup.zip')}, headers={'X-CSRF-Token': token})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        restored = client.get('/api/library').get_json()
        self.assertEqual(restored['scripts'][0]['title'], '备份中的标题')
        self.assertEqual(restored['state']['snapshot']['scripts'][0]['title'], '示例条目')
        self.assertEqual(restored['state']['anchor'], 'para-2')
        self.assertFalse(restored['state']['playing'])
        image_url = restored['scripts'][0]['blocks'][2]['image_path']
        self.assertTrue(image_url.startswith('/media/'))
        image_response = client.get(image_url)
        self.assertEqual(image_response.data, b'\x89PNG\r\nsource-image')
        image_response.close()
        self.assertEqual(len(list((other_root / 'backups').glob('pre-restore-*.zip'))), 1)
        self.assertEqual(len(client.get('/api/scripts/script-a/history').get_json()['history']), 1)
        (self.root / 'static' / 'media' / 'source.png').unlink()
        self.assertEqual(client.get('/api/backup').status_code, 200)

    def test_explicit_top_anchor_survives_apply_and_restore(self):
        state = self.apply_script()
        self.assertIsNone(state['anchor'])
        moved = self.write('/api/command', {'action': 'seek', 'anchor': 'para-2'})
        top = self.write('/api/command', {'action': 'seek', 'anchor': None})
        self.assertIsNone(top['anchor'])
        self.assertGreater(top['seek_version'], moved['seek_version'])
        self.write('/api/checkpoint', {'revision': top['revision'], 'anchor': None})
        self.assertIsNone(self.apply_script(orientation='landscape')['anchor'])
        backup = self.client.get('/api/backup').data
        self.restore(backup)
        self.assertIsNone(self.client.get('/api/state').get_json()['anchor'])
        self.write('/api/command', {'action': 'play'})

    def test_malformed_control_enums_are_validation_errors(self):
        self.write('/api/preview', {'mode': []}, expected=400)
        self.write('/api/preview', {'orientation': {}}, expected=400)
        self.write('/api/preview', {'list_source': []}, expected=400)
        self.write('/api/command', {'action': {}}, expected=400)
        self.write('/api/layouts', {'orientation': []}, method='PATCH', expected=400)

    def test_zip_slip_and_corruption_leave_data_unchanged(self):
        before = self.library()
        bad = io.BytesIO()
        with zipfile.ZipFile(bad, 'w') as archive:
            archive.writestr('../app.py', 'bad')
        self.restore(bad.getvalue(), expected=400)
        backup = self.client.get('/api/backup').data
        corrupted = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(backup)) as source, zipfile.ZipFile(corrupted, 'w') as target:
            for name in source.namelist():
                target.writestr(name, b'broken' if name == 'database.sqlite3' else source.read(name))
        self.restore(corrupted.getvalue(), expected=400)
        self.assertEqual(self.library()['scripts'], before['scripts'])
        self.assertFalse((self.root / 'app.py').exists())
        self.assertFalse((self.root / 'instance' / 'backups').exists())

    def test_matching_hash_does_not_make_trigger_database_trusted(self):
        backup = self.client.get('/api/backup').data
        with zipfile.ZipFile(io.BytesIO(backup)) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        database = self.root / 'tampered.sqlite3'
        database.write_bytes(files['database.sqlite3'])
        connection = sqlite3.connect(database)
        connection.execute('CREATE TRIGGER unwanted AFTER INSERT ON categories BEGIN DELETE FROM scripts; END')
        connection.commit()
        connection.close()
        files['database.sqlite3'] = database.read_bytes()
        manifest = json.loads(files['manifest.json'])
        manifest['files']['database.sqlite3'] = {'size': len(files['database.sqlite3']), 'sha256': hashlib.sha256(files['database.sqlite3']).hexdigest()}
        files['manifest.json'] = json.dumps(manifest).encode()
        changed = io.BytesIO()
        with zipfile.ZipFile(changed, 'w') as archive:
            for name, content in files.items():
                archive.writestr(name, content)
        self.restore(changed.getvalue(), expected=400)
        self.assertEqual(len(self.library()['scripts']), 2)


if __name__ == '__main__':
    unittest.main()
