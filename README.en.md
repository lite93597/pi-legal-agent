# Pi Legal Agent

[简体中文](README.md) · [Optional RAG contract](docs/rag-contract.md)

A legal casework Agent built on the Pi coding agent, with a local web interface and CLI. It combines material intake, source-linked case records, a staged workflow, and reviewable drafts. The included prompts and demonstration materials focus on Chinese legal workflows.

**Bring your own OpenAI-compatible model endpoint.** This repository contains the Agent implementation and synthetic examples. It does not include model weights, training datasets, a legal corpus, vector indexes, or the original deployment's external retrieval service.

## What it does

- **Source-aware intake:** extract TXT, Markdown, DOCX, and text-based PDF files into line-addressable sources without replacing the originals. PDF extraction warnings and pages without extractable text remain visible; intake does not perform OCR.
- **Separate facts from claims:** case records distinguish material-recorded facts, party statements, inferences, legal texts provided, and outstanding checks. A recorded statement is not a finding that it is legally true.
- **Persistent casework:** maintain scope, facts, issues, legal sources, tasks, strategy, and draft registrations separately from the chat history. Revision checks reject conflicting updates.
- **Six stages:** `intake → evidence → analysis → strategy → draft → review`. Stage transitions check for required work products. `review` means awaiting professional review.
- **Traceable citations:** read exact source ranges and verify verbatim quotations. Content hashes detect changes in saved excerpts and knowledge snapshots; they do not authenticate an original or establish legal validity.
- **Optional retrieval:** search registered case materials without RAG. An independently supplied local HTTP service can provide external knowledge through the [RAG contract](docs/rag-contract.md).
- **Recoverable web conversations:** stream text and tool activity, stop requests, reopen saved sessions, and preserve incomplete or failed turn indicators. Context budgets and compaction protect subsequent model requests; stopped work still needs completion.

## Quick start

Requirements: Node.js **22.19 or newer**, npm, Python **3.10 or newer**, and a running OpenAI-compatible Chat Completions endpoint that supports streaming and tool calls.

Run these commands from PowerShell. Substitute your model ID and endpoint:

```powershell
git clone https://github.com/lite93597/pi-legal-agent.git
cd pi-legal-agent
npm ci --ignore-scripts

# Use your endpoint's API key. For an endpoint without authentication:
$env:LEGALAGENT_API_KEY = 'unused'

npm run legal:setup -- --base-url http://127.0.0.1:8000/v1 --model legal-model

python legal/intake/intake.py --case-dir ".local/demo-case" ".local/demo-case/材料/01-合成合同.txt" ".local/demo-case/材料/02-合成付款记录.txt" ".local/demo-case/材料/03-合成往来记录.txt"

npm run legal:web
```

Open **http://127.0.0.1:18005/**. The setup command copies configuration to `.local/agent` and the three synthetic materials to `.local/demo-case`; it does not deploy a model. API key values are read from the environment, not written into configuration. Intake refuses to overwrite an existing manifest or extracted source files; use a separate case directory for another intake.

An example first request:

> Review the imported synthetic contract dispute. Read the materials, record the scope and source-linked facts, separate disputed claims, identify missing evidence, and suggest the next step. Mark legal authorities that still need verification.

The materials and the Agent's default guidance are in Chinese. The example case is fictional and deliberately contains evidence gaps.

### Enable draft saving

```powershell
npm run legal:web -- --allow-write
```

Draft saving is disabled by default. Enabling it allows the draft tool to save new files under the selected case's `outputs/legalagent/`. Workflow records and web sessions are persisted even when draft saving is disabled.

### Use your own case or the CLI

Keep the original materials inside a case directory, then import the specific files you want the Agent to access:

```powershell
python legal/intake/intake.py --case-dir "cases/case-a" "cases/case-a/materials/contract.txt"
npm run legal:web -- --case-dir "cases/case-a" --port 18006

npm run legal:cli -- --case-dir ".local/demo-case"
npm run legal:cli -- --case-dir ".local/demo-case" --prompt "List the materials and outstanding checks."
```

The CLI saves conversations by default; add `--no-save-session` to disable chat session storage. See [intake instructions](legal/intake/README.md) for supported formats, encoding, locator semantics, and extraction limitations. Only PDF intake needs the optional dependency:

```powershell
python -m pip install "pypdf==6.14.2"
```

### Configure optional RAG

```powershell
$env:LEGAL_RAG_URL = 'http://127.0.0.1:18020'
npm run legal:web
```

This must be the service **root URL**, without `/search`. Only explicit loopback HTTP addresses are accepted; redirects are rejected. The service must implement `/health` and `/search` as specified in [docs/rag-contract.md](docs/rag-contract.md). No RAG backend, corpus, embedding model, or index is distributed here. An unconfigured or failed knowledge service reports a tool error, rather than a successful empty search. Registered case-material retrieval remains available.

### Match your model's limits

The configuration template uses an example context window and output limit. After setup, adjust `.local/agent/models.json` and `.local/agent/settings.json` to match the actual model server, including supported request fields, `contextWindow`, `maxTokens`, and compaction settings. The setup command changes the endpoint and model ID; it does not discover the server's real token limits or install model weights.

## Tools and workflow

| Tools | Role |
| --- | --- |
| `legal_sources_list`, `legal_source_read` | Inspect imported sources, extraction quality, and exact line ranges. |
| `legal_citation_verify` | Check whether a verbatim quotation exists at the supplied source. |
| `legal_retrieve` | Choose `case` for registered materials or `knowledge` for the optional external service. |
| `legal_case_status`, `legal_case_update` | Read and update durable casework with revision checks and source references. |
| `legal_case_advance` | Request a stage transition subject to work-product checks. |
| `legal_draft_save` | Save a new structured draft and register its references and unresolved items when writing is enabled. |

The launcher selects legal extensions, skills, prompt templates, and a restricted tool set. The workflow is implemented in code as well as in model instructions. The model still chooses how to reason and which tools to call; schema, revision, source, and stage checks constrain what can be persisted.

Useful prompt templates include `/case-intake`, `/timeline`, `/contract-review`, `/legal-memo`, and `/draft-document`.

## Project layout

| Location | Contents |
| --- | --- |
| `legal/intake/` | Offline material extraction and synthetic tests. |
| `legal/extensions/` | Source, citation, retrieval, and workflow tools. |
| `legal/workflow/` | Case-state store, revisions, draft registration, and stage checks. |
| `legal/web/` | Local server, browser UI, context guards, and session persistence. |
| `legal/config/`, `legal/skills/`, `legal/prompts/` | Configuration templates and legal guidance. |
| `scripts/legal-setup.mjs`, `scripts/legal-launch.mjs` | Portable setup and launch commands. |
| `examples/demo-case/` | Entirely synthetic demonstration materials. |
| `packages/` | Pi runtime and supporting packages; see the [coding-agent documentation](packages/coding-agent/README.md). |
| `.local/` | Generated local configuration and demo working copy; excluded from Git. |

## Verification and limits

```powershell
npm run legal:check
npm run legal:test
python -m unittest discover -s legal/intake -p "test_*.py" -v
```

Tests use synthetic inputs and mocks; they do not establish the accuracy of an arbitrary model or legal corpus. Citation existence and draft structure checks do not establish that an argument is supported, that evidence is authentic, or that a law applies. Human source review and professional judgment remain necessary before using a draft in a real matter.

Case directories can contain sensitive originals, extracted text, workflow records, knowledge snapshots, and conversations. Keep those runtime artifacts out of public repositories. The repository's ignored paths help with the included working layout; they are not an automatic privacy filter for user-selected directories.

## License and upstream

[MIT License](LICENSE). This project builds on the Pi coding-agent runtime and retains its upstream license notice. The legal adaptations, web interface, and synthetic examples are supplied here; model and external data licensing are the responsibility of their respective providers.
