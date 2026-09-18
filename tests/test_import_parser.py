"""Offline parser fidelity and hostile-input boundaries."""
import io
import struct
import unittest
import zipfile
from unittest.mock import patch

from import_parser import parse_text, parse_upload, extract_docx
from storage import DomainError

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def docx(body, additions=None, compression=zipfile.ZIP_DEFLATED):
    output = io.BytesIO()
    xml = '<w:document xmlns:w="' + W + '"><w:body>' + body + '</w:body></w:document>'
    with zipfile.ZipFile(output, 'w', compression) as archive:
        archive.writestr('word/document.xml', xml.encode())
        for name, value in (additions or {}).items():
            archive.writestr(name, value)
    return output.getvalue()


class ImportParserTests(unittest.TestCase):
    def test_role_metadata_preserves_source_and_nonempty_lines(self):
        source = '剧名：雪夜\r\n作者：小云\r\n\r\n小喜：  第一段。\n旁白:窗外下雪。\n没有指定角色的原文\n12:30\n'
        result = parse_text(source)
        candidate = result['candidate']
        self.assertEqual(candidate['title'], '雪夜')
        self.assertEqual(candidate['author'], '小云')
        self.assertEqual(result['roles'], ['小喜', '旁白'])
        self.assertEqual([block['text'] for block in candidate['blocks']], [line for line in source.splitlines(keepends=True) if line.strip()])
        self.assertEqual(candidate['source_text'], source)
        self.assertEqual(candidate['blocks'][0]['role'], '')
        self.assertEqual(candidate['blocks'][-1]['role'], '')
        self.assertTrue(all(block['id'].startswith('block-') for block in candidate['blocks']))
        self.assertEqual(len({block['id'] for block in candidate['blocks']}), len(candidate['blocks']))

    def test_ambiguous_body_keeps_original_text_without_inventing_roles(self):
        source = '（窗外的雨声）\n【场景一】\n她推开了门。\n'
        result = parse_text(source, '原文.txt')
        self.assertEqual(result['roles'], [])
        self.assertEqual(result['candidate']['title'], '原文')
        self.assertEqual(''.join(block['text'] for block in result['candidate']['blocks']), source)
        self.assertTrue(any('未指定' in warning for warning in result['warnings']))

    def test_import_skips_whitespace_only_lines_but_keeps_source_and_nonblank_bytes(self):
        source = '\n \t \r\n　\n  甲：保留两侧空格。  \r\n\t旁白：第二段\n\t　'
        expected = ['  甲：保留两侧空格。  \r\n', '\t旁白：第二段\n']
        for label, result in [('paste', parse_text(source)),
                              ('TXT', parse_upload(io.BytesIO(source.encode('utf-8-sig')), '空行.txt'))]:
            with self.subTest(source=label):
                self.assertEqual(result['candidate']['source_text'], source)
                self.assertEqual([block['text'] for block in result['candidate']['blocks']], expected)
                self.assertEqual(result['roles'], ['甲', '旁白'])
                self.assertTrue(any('已跳过 4 个纯空行' in warning for warning in result['warnings']))
        document = docx('<w:p/><w:p><w:r><w:t xml:space="preserve"> </w:t><w:tab/></w:r></w:p>'
                        '<w:p><w:r><w:t>　</w:t></w:r></w:p>'
                        '<w:p><w:r><w:t xml:space="preserve">  甲：保留两侧空格。  </w:t></w:r></w:p>'
                        '<w:p><w:r><w:tab/><w:t>旁白：第二段</w:t></w:r></w:p>')
        result = parse_upload(io.BytesIO(document), '空行.docx')
        self.assertEqual(result['candidate']['source_text'], '\n \t\n　\n  甲：保留两侧空格。  \n\t旁白：第二段')
        self.assertEqual([block['text'] for block in result['candidate']['blocks']],
                         ['  甲：保留两侧空格。  \n', '\t旁白：第二段'])
        self.assertTrue(any('已跳过 3 个纯空行' in warning for warning in result['warnings']))
        unknown = parse_text('\n　\n（没有角色前缀）')
        self.assertNotIn('全部原文已保留', ' '.join(unknown['warnings']))
        self.assertEqual(len(unknown['candidate']['blocks']), 1)

    def test_txt_utf8_bom_and_gb18030_are_explicit(self):
        source = '《春天》\n甲：你好\n'
        for content, encoding in [(source.encode(), 'UTF-8'), (source.encode('utf-8-sig'), 'UTF-8 BOM'),
                                  (source.encode('gb18030'), 'GB18030')]:
            with self.subTest(encoding=encoding):
                result = parse_upload(io.BytesIO(content), '本子.TXT')
                self.assertEqual(result['encoding'], encoding)
                self.assertEqual(result['candidate']['source_text'], source)
                self.assertEqual(result['candidate']['title'], '春天')
                if encoding == 'GB18030':
                    self.assertTrue(any('乱码' in warning for warning in result['warnings']))

    def test_docx_paragraph_table_and_inline_break_order(self):
        source = docx('<w:p><w:r><w:t>剧名：旅途</w:t></w:r></w:p>'
                      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲：</w:t><w:t>第一句</w:t><w:tab/><w:t>继续</w:t><w:br/><w:t>下一行</w:t></w:r></w:p></w:tc>'
                      '<w:tc><w:p><w:r><w:t>乙：第二句</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
                      '<w:p/><w:p><w:r><w:t>最后一段</w:t></w:r></w:p>')
        result = parse_upload(io.BytesIO(source), 'table.docx')
        expected = '剧名：旅途\n甲：第一句\t继续\n下一行\n乙：第二句\n\n最后一段'
        self.assertEqual(result['candidate']['source_text'], expected)
        self.assertEqual([block['text'] for block in result['candidate']['blocks']], [line for line in expected.splitlines(keepends=True) if line.strip()])
        self.assertEqual(result['roles'], ['甲', '乙'])
        self.assertEqual(result['encoding'], 'DOCX')

    def test_docx_images_and_auxiliary_text_warn_without_fabrication(self):
        source = docx('<w:p><w:r><w:t>旁白：唯一正文</w:t><w:drawing/></w:r></w:p>',
                      {'word/media/image1.png': b'not decoded', 'word/header1.xml': '<header>附属</header>'})
        result = parse_upload(io.BytesIO(source), 'image.docx')
        self.assertEqual(result['candidate']['source_text'], '旁白：唯一正文')
        self.assertTrue(any('OCR' in warning for warning in result['warnings']))
        self.assertTrue(any('页眉' in warning for warning in result['warnings']))
        revision = docx('<w:p><w:del><w:r><w:delText>旧文字</w:delText></w:r></w:del>'
                        '<w:ins><w:r><w:t>新文字</w:t></w:r></w:ins></w:p>')
        imported = parse_upload(io.BytesIO(revision), 'revision.docx')
        self.assertEqual(imported['candidate']['source_text'], '旧文字新文字')
        self.assertTrue(any('修订' in warning for warning in imported['warnings']))

    def test_docx_rejects_malformed_missing_document_and_zip_paths(self):
        with self.assertRaises(DomainError):
            extract_docx(b'not a ZIP')
        with self.assertRaises(DomainError):
            extract_docx(docx('<w:p>broken'))
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            archive.writestr('something.xml', '<root/>')
        with self.assertRaises(DomainError):
            extract_docx(output.getvalue())
        for name in ('../escape.txt', '/absolute.txt', 'C:/escape.txt'):
            with self.subTest(name=name), self.assertRaises(DomainError):
                extract_docx(docx('<w:p/>', {name: 'bad'}))
        backslash_name = docx('<w:p/>', {'word/escape.txt': 'bad'}).replace(b'word/escape.txt', b'word\\escape.txt')
        with self.assertRaises(DomainError):
            extract_docx(backslash_name)

    def test_docx_rejects_entities_in_utf8_utf16_and_auxiliary_xml(self):
        declaration = '<!DOCTYPE x [<!ENTITY secret "expanded">]>'
        document = declaration + '<w:document xmlns:w="' + W + '"><w:body><w:p><w:r><w:t>&secret;</w:t></w:r></w:p></w:body></w:document>'
        for encoding in ('utf-8', 'utf-16'):
            output = io.BytesIO()
            with zipfile.ZipFile(output, 'w') as archive:
                archive.writestr('word/document.xml', document.encode(encoding))
            with self.subTest(encoding=encoding), self.assertRaises(DomainError):
                extract_docx(output.getvalue())
        with self.assertRaises(DomainError):
            extract_docx(docx('<w:p/>', {'word/styles.xml': declaration + '<root/>'}))

    def test_docx_rejects_encryption_and_unsupported_compression(self):
        original = bytearray(docx('<w:p><w:r><w:t>文本</w:t></w:r></w:p>'))
        # Mark both ZIP headers encrypted without relying on an encryption library.
        local = original.index(b'PK\x03\x04')
        central = original.index(b'PK\x01\x02')
        for location in (local + 6, central + 8):
            value = struct.unpack_from('<H', original, location)[0]
            struct.pack_into('<H', original, location, value | 1)
        with self.assertRaises(DomainError):
            extract_docx(bytes(original))
        with self.assertRaises(DomainError):
            extract_docx(docx('<w:p/>', compression=zipfile.ZIP_BZIP2))

    def test_import_size_count_and_text_limits_are_checked(self):
        for value in ('', '   ', 'bad\x00text', 'a' * 300001, 'line\n' * 10001):
            with self.subTest(length=len(value)), self.assertRaises(DomainError):
                parse_text(value)
        with self.assertRaises(DomainError):
            parse_upload(io.BytesIO(b'x' * (2 * 1024 * 1024 + 1)), 'large.txt')
        with self.assertRaises(DomainError):
            parse_upload(io.BytesIO(b'x' * (10 * 1024 * 1024 + 1)), 'large.docx')
        with self.assertRaises(DomainError):
            parse_upload(io.BytesIO(b'data'), 'not-supported.pdf')
        # Small thresholds exercise actual archive/paragraph limit branches while
        # keeping the test fixture bounded and independent of machine memory.
        with patch('import_parser.MAX_DOCX_EXPANDED', 8), self.assertRaises(DomainError):
            extract_docx(docx('<w:p/>'))
        with patch('import_parser.MAX_DOCX_ENTRIES', 1), self.assertRaises(DomainError):
            extract_docx(docx('<w:p/>', {'extra.bin': b'a'}))
        with patch('import_parser.MAX_PARAGRAPHS', 1), self.assertRaises(DomainError):
            extract_docx(docx('<w:p/><w:p/>'))


if __name__ == '__main__':
    unittest.main()
