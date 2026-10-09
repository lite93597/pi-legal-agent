# 案件材料离线预处理

`intake.py` 接收案件目录内明确指定的 `.txt`、`.md`、`.pdf`、`.docx` 文件，将其正文按来源转成带定位符的 UTF-8 纯文本。它不调用模型、不联网、不移动或覆盖原件。

## 使用

从项目根目录运行，替换示例中的案件目录及文件路径：

```sh
python legal/intake/intake.py --case-dir "cases/case-a" "cases/case-a/materials/interview.txt" "cases/case-a/materials/contract.docx"
```

输出固定在案件目录下的 `.legalagent/sources/`：`manifest.json`、`S001.txt`、`S002.txt` 等。再次运行若目标文件已存在，会报错并拒绝覆盖。不同案件请使用不同案件目录。`txt/md` 默认按 UTF-8（含 BOM）解码；旧编码材料可加 `--encoding gb18030`。

`manifest.json` 的 `version` 为 1，`sources` 中每个来源至少包含 `id`、`original_path`、`processed_path`、`sha256`、`kind`。两个路径都相对 `manifest.json` 所在目录，案件目录整体迁移后仍能解析。另有文件大小、页数、行数、页码类型、OCR 状态和警告。

每行以 `[p0001:L0001]` 开头。PDF 的 `p` 是原 PDF 页码，`L` 是该页提取文本的行号；其他格式没有可靠物理页码，统一使用虚拟 `p0001`，并在 manifest 中写明 `page_numbering: synthetic_p0001`。引用时同时写来源 ID，例如 `S001 [p0001:L0003]`。

DOCX 读取正文段落及表格，按 XML 中的段落、行、单元格顺序展平；页眉、页脚、批注和嵌入附件不作为正文提取。PDF 采用 pypdf 的文本提取顺序；复杂分栏或文字图层的视觉阅读顺序可能与提取顺序不同，需人工核对。扫描 PDF 页面若无可提取文本，会列入 `pages_without_extractable_text` 并警告；工具不做 OCR。DOCX 中的图片文字也不做 OCR。

只有处理 PDF 时需要可选依赖 `pypdf==6.14.2`；若环境缺少该库，运行：

```sh
python -m pip install "pypdf==6.14.2"
```

TXT、Markdown、DOCX 仅依赖 Python 标准库。预处理结果和 manifest 可能含案件敏感信息，应按案件材料同等方式保管。

测试只生成临时合成文件，不读取真实案件材料：

```sh
python -m unittest discover -s legal/intake -p "test_*.py" -v
```

PDF 测试另外需要 `reportlab` 来生成合成 PDF；缺少它时仅跳过该项测试，预处理 PDF 本身不依赖 reportlab。
