"""Offline intake of case files into line-addressable plain text."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path
from typing import Iterator
from xml.etree import ElementTree


SUPPORTED_KINDS = {".txt": "txt", ".md": "md", ".pdf": "pdf", ".docx": "docx"}
WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class IntakeError(Exception):
    """An input cannot be processed without risking incomplete output."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _relative(path: Path, base: Path) -> str:
    return os.path.relpath(path, base).replace(os.sep, "/")


def _plain_lines(path: Path, encoding: str) -> list[str]:
    try:
        content = path.read_text(encoding=encoding)
    except (UnicodeError, LookupError) as exc:
        raise IntakeError(f"无法按 {encoding} 解码 {path.name}；可用 --encoding 指定编码") from exc
    if "\x00" in content:
        raise IntakeError(f"{path.name} 含 NUL 字符，可能不是纯文本")
    return content.splitlines()


def _word_paragraph_text(paragraph: ElementTree.Element) -> str:
    parts: list[str] = []
    for element in paragraph.iter():
        if element.tag == f"{WORD_NS}t":
            parts.append(element.text or "")
        elif element.tag == f"{WORD_NS}tab":
            parts.append("\t")
        elif element.tag in (f"{WORD_NS}br", f"{WORD_NS}cr"):
            parts.append("\n")
    return "".join(parts)


def _word_paragraphs(element: ElementTree.Element) -> Iterator[str]:
    # Descend through tables and cells in XML order, without visiting a paragraph twice.
    for child in element:
        if child.tag == f"{WORD_NS}p":
            yield _word_paragraph_text(child)
        else:
            yield from _word_paragraphs(child)


def _docx_lines(path: Path) -> tuple[list[str], list[str]]:
    try:
        with zipfile.ZipFile(path) as archive:
            document = ElementTree.fromstring(archive.read("word/document.xml"))
            has_media = any(name.startswith("word/media/") for name in archive.namelist())
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError) as exc:
        raise IntakeError(f"{path.name} 不是可读取的 DOCX 正文") from exc

    body = document.find(f"{WORD_NS}body")
    if body is None:
        raise IntakeError(f"{path.name} 缺少 DOCX 正文")
    lines = [line for paragraph in _word_paragraphs(body) for line in paragraph.split("\n")]
    warnings = []
    if has_media:
        warnings.append("DOCX 含嵌入图片；未执行 OCR，图片中的文字未提取")
    return lines, warnings


def _pdf_pages(path: Path) -> tuple[list[list[str]], list[str], list[int]]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise IntakeError("处理 PDF 需要 pypdf：python -m pip install pypdf==6.14.2") from exc

    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted:
            raise IntakeError(f"{path.name} 是加密 PDF；请先提供可读取的副本")
        pages = [(page.extract_text() or "").splitlines() for page in reader.pages]
    except IntakeError:
        raise
    except Exception as exc:
        raise IntakeError(f"{path.name} 不是可读取的 PDF 或文本提取失败") from exc

    empty_pages = [number for number, lines in enumerate(pages, 1) if not "".join(lines).strip()]
    warnings = []
    if empty_pages:
        warnings.append(f"PDF 第 {', '.join(map(str, empty_pages))} 页没有可提取文字；未执行 OCR，可能需要人工核对扫描页")
    return pages, warnings, empty_pages


def _extract(path: Path, kind: str, encoding: str) -> tuple[list[list[str]], list[str], list[int]]:
    if kind in ("txt", "md"):
        return [_plain_lines(path, encoding)], [], []
    if kind == "docx":
        lines, warnings = _docx_lines(path)
        return [lines], warnings, []
    return _pdf_pages(path)


def process(case_dir: Path, files: list[Path], encoding: str = "utf-8-sig") -> Path:
    """Write a new manifest and source texts; never replace existing output or input."""
    try:
        case_dir = case_dir.resolve(strict=True)
    except FileNotFoundError as exc:
        raise IntakeError(f"案件目录不存在：{case_dir}") from exc
    if not case_dir.is_dir():
        raise IntakeError(f"案件路径不是目录：{case_dir}")
    if not files:
        raise IntakeError("至少指定一个本地文件")

    output_dir = case_dir / ".legalagent" / "sources"
    for directory in (output_dir.parent, output_dir):
        if directory.exists() and not directory.resolve().is_relative_to(case_dir):
            raise IntakeError(f"输出目录指向案件目录之外：{directory}")

    planned: list[tuple[str, dict[str, object]]] = []
    seen: set[Path] = set()
    for number, raw_path in enumerate(files, 1):
        try:
            path = raw_path.resolve(strict=True)
        except FileNotFoundError as exc:
            raise IntakeError(f"输入文件不存在：{raw_path}") from exc
        if not path.is_file():
            raise IntakeError(f"输入路径不是文件：{raw_path}")
        if not path.is_relative_to(case_dir) or path.is_relative_to(case_dir / ".legalagent"):
            raise IntakeError(f"输入文件必须在案件目录内，且不能来自 .legalagent：{raw_path}")
        if path in seen:
            raise IntakeError(f"重复输入文件：{raw_path}")
        seen.add(path)
        kind = SUPPORTED_KINDS.get(path.suffix.lower())
        if kind is None:
            raise IntakeError(f"不支持 {path.name} 的格式；仅支持 txt、md、pdf、docx")

        pages, warnings, empty_pages = _extract(path, kind, encoding)
        source_id = f"S{number:03d}"
        output_lines = [
            f"[p{page_number:04d}:L{line_number:04d}] {text}"
            for page_number, lines in enumerate(pages, 1)
            for line_number, text in enumerate(lines, 1)
        ]
        entry: dict[str, object] = {
            "id": source_id,
            "original_path": _relative(path, output_dir),
            "processed_path": f"{source_id}.txt",
            "sha256": _sha256(path),
            "kind": kind,
            "bytes": path.stat().st_size,
            "page_count": len(pages),
            "page_numbering": "physical_pdf" if kind == "pdf" else "synthetic_p0001",
            "line_count": len(output_lines),
            "ocr_status": "not_performed" if kind in ("pdf", "docx") else "not_applicable",
            "pages_without_extractable_text": empty_pages,
            "warnings": warnings,
        }
        planned.append(("\n".join(output_lines) + ("\n" if output_lines else ""), entry))

    manifest_path = output_dir / "manifest.json"
    targets = [output_dir / entry["processed_path"] for _, entry in planned]
    targets.append(manifest_path)
    existing = [target for target in targets if target.exists()]
    if existing:
        raise IntakeError(f"输出已存在，拒绝覆盖：{existing[0]}")

    output_dir.mkdir(parents=True, exist_ok=True)
    created: list[Path] = []
    try:
        for content, entry in planned:
            path = output_dir / str(entry["processed_path"])
            with path.open("x", encoding="utf-8", newline="\n") as stream:
                created.append(path)
                stream.write(content)
        manifest = {"version": 1, "sources": [entry for _, entry in planned]}
        with manifest_path.open("x", encoding="utf-8", newline="\n") as stream:
            created.append(manifest_path)
            json.dump(manifest, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    except OSError:
        for path in created:
            path.unlink(missing_ok=True)
        raise
    return manifest_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="离线提取案件材料，生成可引用的逐行文本和 manifest")
    parser.add_argument("--case-dir", required=True, type=Path, help="案件目录；原件需位于此目录内")
    parser.add_argument("--encoding", default="utf-8-sig", help="txt/md 的编码，默认 utf-8-sig")
    parser.add_argument("files", nargs="+", type=Path, help="需处理的本地 txt/md/pdf/docx 文件")
    args = parser.parse_args(argv)
    try:
        manifest_path = process(args.case_dir, args.files, args.encoding)
    except IntakeError as exc:
        parser.exit(2, f"错误：{exc}\n")
    except OSError as exc:
        parser.exit(2, f"文件读写失败：{exc}\n")
    print(manifest_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
