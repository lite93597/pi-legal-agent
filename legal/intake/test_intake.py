"""Tests use only synthetic files in an OS temporary directory."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from intake import IntakeError, process


WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


class IntakeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="legal-intake-test-")
        self.addCleanup(self.temporary.cleanup)
        self.case_dir = Path(self.temporary.name) / "case"
        self.case_dir.mkdir()
        self.case_dir = self.case_dir.resolve()

    def _manifest(self) -> tuple[Path, dict[str, object]]:
        path = self.case_dir / ".legalagent" / "sources" / "manifest.json"
        return path, json.loads(path.read_text(encoding="utf-8"))

    def test_text_and_markdown_keep_line_order_and_relative_sources(self) -> None:
        text = self.case_dir / "访谈.txt"
        markdown = self.case_dir / "记录.md"
        original = "第一行\n\n第三行\n".encode("utf-8")
        text.write_bytes(original)
        markdown.write_text("# 标题\n内容", encoding="utf-8")

        manifest_path = process(self.case_dir, [text, markdown])
        path, manifest = self._manifest()
        self.assertEqual(path, manifest_path)
        self.assertEqual(manifest["version"], 1)
        self.assertEqual([entry["id"] for entry in manifest["sources"]], ["S001", "S002"])
        first = manifest["sources"][0]
        self.assertEqual(first["kind"], "txt")
        self.assertEqual(first["page_numbering"], "synthetic_p0001")
        self.assertEqual(first["sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual((path.parent / first["original_path"]).resolve(), text)
        self.assertEqual(
            (path.parent / first["processed_path"]).read_text(encoding="utf-8"),
            "[p0001:L0001] 第一行\n[p0001:L0002] \n[p0001:L0003] 第三行\n",
        )
        self.assertEqual(
            (path.parent / manifest["sources"][1]["processed_path"]).read_text(encoding="utf-8"),
            "[p0001:L0001] # 标题\n[p0001:L0002] 内容\n",
        )
        self.assertEqual(text.read_bytes(), original)

        with self.assertRaisesRegex(IntakeError, "拒绝覆盖"):
            process(self.case_dir, [text, markdown])
        self.assertEqual(text.read_bytes(), original)

    def test_docx_follows_body_paragraph_and_table_cell_order(self) -> None:
        source = self.case_dir / "合同.docx"
        xml = f"""<w:document xmlns:w="{WORD_NAMESPACE}"><w:body>
<w:p><w:r><w:t>前言</w:t></w:r></w:p>
<w:tbl><w:tr>
<w:tc><w:p><w:r><w:t>甲方</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>乙方</w:t></w:r></w:p></w:tc>
</w:tr></w:tbl>
<w:p><w:r><w:t>末尾</w:t><w:br/><w:t>续行</w:t></w:r></w:p>
</w:body></w:document>"""
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("word/document.xml", xml)
            archive.writestr("word/media/image1.png", b"synthetic image bytes")

        process(self.case_dir, [source])
        path, manifest = self._manifest()
        entry = manifest["sources"][0]
        self.assertEqual(entry["kind"], "docx")
        self.assertEqual(entry["ocr_status"], "not_performed")
        self.assertTrue(any("未执行 OCR" in warning for warning in entry["warnings"]))
        self.assertEqual(
            (path.parent / entry["processed_path"]).read_text(encoding="utf-8").splitlines(),
            [
                "[p0001:L0001] 前言",
                "[p0001:L0002] 甲方",
                "[p0001:L0003] 乙方",
                "[p0001:L0004] 末尾",
                "[p0001:L0005] 续行",
            ],
        )

    @unittest.skipUnless(
        importlib.util.find_spec("pypdf") and importlib.util.find_spec("reportlab"),
        "PDF extraction test requires pypdf and reportlab",
    )
    def test_pdf_real_page_numbers_and_ocr_warning(self) -> None:
        from reportlab.pdfgen import canvas

        source = self.case_dir / "附件.pdf"
        pdf = canvas.Canvas(str(source))
        pdf.drawString(72, 720, "Alpha")
        pdf.drawString(72, 700, "Beta")
        pdf.showPage()
        pdf.showPage()  # An intentionally blank second page.
        pdf.save()

        process(self.case_dir, [source])
        path, manifest = self._manifest()
        entry = manifest["sources"][0]
        lines = (path.parent / entry["processed_path"]).read_text(encoding="utf-8").splitlines()
        self.assertEqual(entry["kind"], "pdf")
        self.assertEqual(entry["page_count"], 2)
        self.assertEqual(entry["page_numbering"], "physical_pdf")
        self.assertEqual(entry["pages_without_extractable_text"], [2])
        self.assertTrue(any("未执行 OCR" in warning for warning in entry["warnings"]))
        self.assertIn("[p0001:L0001] Alpha", lines)
        self.assertIn("[p0001:L0002] Beta", lines)
        self.assertFalse(any(line.startswith("[p0002:") for line in lines))

    def test_invalid_input_has_no_output_and_cli_reports_error(self) -> None:
        invalid = self.case_dir / "raw.txt"
        invalid.write_bytes(b"\xff")
        with self.assertRaisesRegex(IntakeError, "无法按"):
            process(self.case_dir, [invalid])
        self.assertFalse((self.case_dir / ".legalagent").exists())

        invalid.rename(self.case_dir / "raw.png")
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("intake.py")), "--case-dir", str(self.case_dir), str(self.case_dir / "raw.png")],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "ascii"},
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("不支持", result.stderr)
        self.assertFalse((self.case_dir / ".legalagent").exists())


if __name__ == "__main__":
    unittest.main()
