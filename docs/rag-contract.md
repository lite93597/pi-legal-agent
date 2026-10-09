# 可选 RAG HTTP 契约

公开包提供 Agent 侧 HTTP 适配器、来源快照与引用检查，不包含检索后端、模型权重、法律数据、向量索引或真实案件。原部署的检索服务依赖独立的数据与检索项目，不能仅凭本包复现。可以自行实现以下接口；检索算法、数据授权、来源审核和日期适用判断由服务提供方负责。

不配置 RAG 也可启动 Agent、登记和读取本案材料，并使用 `legal_retrieve` 的 `corpus: "case"`。`corpus: "knowledge"` 请求未配置的服务会抛出“外部知识检索未配置”，不会伪装成一次成功的空检索。模型 API 和 RAG 是两个独立服务。

## 1. 地址配置

在启动 Agent 的进程环境中设置服务根 URL，例如 PowerShell：

```powershell
$env:LEGAL_RAG_URL = 'http://127.0.0.1:18020'
```

适配器动态读取 `LEGAL_RAG_URL`，仅接受 `http://localhost`、`http://127.0.0.1`、`http://[::1]` 及可选端口。允许末尾 `/` 和首尾空白；不允许其他路径（包括 `/search`）、用户名或密码、query、hash、HTTPS、其他 IP、其他域名、反斜杠或内部空白。端口由 URL 解析器校验。未设置、空字符串及纯空白表示未配置。

导出的共享方法位于 `legal/extensions/internal/rag-core.ts`：

```ts
resolveKnowledgeEndpoint(value: string | undefined): string | undefined;
readKnowledgeEndpoint(): string | undefined;
getKnowledgeServiceUrl(route: "search" | "health"): string | undefined;
```

前两个方法返回规范化根 URL，第三个附加路由。未配置返回 `undefined`，非法配置抛错；错误信息不回显配置值中的凭据。搜索请求使用 `redirect: "error"`，拒绝全部 HTTP 重定向，包括重定向到另一端口或同一服务。服务应直接在 `/search` 和 `/health` 响应，不使用跳转代理。

本机地址限制不构成身份认证或运行隔离。服务提供方仍须控制监听地址、访问权限及运行时日志；若本机代理向远程转发，实际数据流由该代理决定。

## 2. 健康接口

`GET /health` 返回 JSON。建议最小响应为：

```json
{"ready":true,"state":"ready","phase":"ready"}
```

`ready` 为布尔值；索引加载或初始化失败时应为 `false`。`state`、`phase` 可用于展示状态，其他诊断字段可选。健康响应不能证明法规现行有效、数据完整或检索结果正确；服务不可用也不代表模型 API 不可用。

## 3. 搜索请求

`POST /search`，`Content-Type: application/json`，正文只包含以下字段。Agent 不发送完整会话或案件目录；`query` 自身可能含案件信息，服务仍须妥善处理。

```json
{
  "query":"示例规范第二条的程序要求",
  "limit":2,
  "mode":"date",
  "as_of":"2024-06-01",
  "jurisdiction":"示例法域"
}
```

| 字段 | 约定 |
| --- | --- |
| `query` | 必填，非空字符串，最多 500 字符。不得包含非法控制字符。 |
| `limit` | 必填，整数 1–4。这是返回给 Agent 的文档上限，与服务内部召回候选数量无关。 |
| `mode` | 可选，`current`、`date` 或 `historical`；默认 `current`。 |
| `as_of` | `date` / `historical` 必填，真实日历日期 `YYYY-MM-DD`；`current` 不应携带。 |
| `jurisdiction` | 可选，非空字符串，最多 80 字符。 |

服务须校验完整请求语义并以 HTTP 400 拒绝不合法组合。Agent 的工具入口检查 query/limit，schema 限制字段类型；HTTP 适配器本身不是完整日期或法域校验器。

`current` 应明确以哪一天的来源审核或索引快照为基准，不能暗示实时核验。`date` 应按指定适用日筛选候选；`historical` 可采用同一日期筛选，但须保留请求模式并告知历史版本覆盖范围。请求日期超出已审核范围时，应明确说明限制，不把无终止日期当作将来仍有效的证明。生效区间、废止日期、地方规则、过渡规则及个案前提由后端处理，Agent 不从 metadata 自动推导其真实性或效力。

## 4. 搜索响应

成功响应为 HTTP 200 的 UTF-8 JSON 对象。例如，下面的文本、机构、法域及地址全部为合成示例：

```json
{
  "scope":{
    "mode":"date",
    "as_of":"2024-06-01",
    "jurisdiction":"示例法域",
    "requested_mode":"date",
    "normative_only":true,
    "local_only":false,
    "requested_publication_after_snapshot":false
  },
  "index":{"fingerprint":"synthetic-index-v1","as_of":"2024-12-31"},
  "retrieval_mode":"synthetic_exact_reference",
  "documents":[{
    "document_id":"synthetic-rule-v1-article-2",
    "text":"第一条 本示例仅用于接口测试。\n第二条 当事人可以提交书面说明。",
    "metadata":{
      "title":"示例规范（合成测试文本）",
      "source_url":"https://example.test/synthetic-rule",
      "publisher":"示例发布机构",
      "document_type":"normative",
      "jurisdiction":"示例法域",
      "version":"synthetic-v1",
      "published_on":"2024-01-01",
      "effective_from":"2024-02-01",
      "effective_to":"",
      "status":"synthetic_unverified",
      "checked_on":"2024-12-31",
      "article":"2",
      "case_number":"",
      "provenance":"合成资料；不构成真实法律依据"
    }
  }],
  "warnings":["合成资料；未进行法律效力认证"],
  "trace":{"reference_guard":true,"evidence_status":"retrieved_unverified"}
}
```

适配器的实际接收边界如下。字符串长度均按 JavaScript `string.length`（UTF-16 代码单元）计算；所有字符串禁止 NUL。标注“非空”的字段不接受纯空白。

| 位置 | 必需类型及上限 |
| --- | --- |
| `scope` | 对象；下列 7 个字段均须提供。 |
| `scope.mode` / `scope.requested_mode` | 非空字符串，各最多 30。前者是执行模式，后者是原请求模式，历史请求允许执行模式归一为 `date`。 |
| `scope.as_of` | `null` 或非空字符串，最多 10。 |
| `scope.jurisdiction` | `null` 或非空字符串，最多 80。 |
| `scope.normative_only` / `scope.local_only` / `scope.requested_publication_after_snapshot` | 布尔值；不可使用字符串 `"true"`。 |
| `index.fingerprint` | 非空字符串，最多 200。应识别服务此次使用的索引版本。 |
| `index.as_of` | 字符串，最多 100，可为空；空表示截至时间未登记。 |
| `retrieval_mode` | 非空字符串，最多 100；说明执行的检索路径，不是置信度。 |
| `documents` | 数组，数量不得超过请求 `limit`，可以为空。 |
| 每项 `document_id` | 非空字符串，最多 200。 |
| 每项 `text` | 非空字符串，最多 50,000。 |
| 每项 `metadata` | 对象，只接受下文列出的字段；每个值须为字符串，最多 1,000，可为空。 |
| `warnings` | 数组，最多 20 项；每项非空字符串，最多 1,000。 |
| `trace.reference_guard` | 必填布尔值。 |
| `trace.evidence_status` | 必填，`null` 或最多 120 字符的状态标识，须匹配 `^[a-z][a-z0-9_]*$`；不可包含自由文本。 |

metadata 白名单是 `title`、`source_url`、`publisher`、`document_type`、`jurisdiction`、`version`、`published_on`、`effective_from`、`effective_to`、`status`、`checked_on`、`article`、`case_number`、`provenance`。缺失或空值表示未登记，不能当作已经核实。含未知 metadata 字段会拒绝整份响应；其他对象的额外字段不会透传给 Agent，也不会进入快照。

服务应使用真实日历日期和一致的作用域字段。适配器校验响应的形状、类型和大小，不验证这些日期、URL、fingerprint 是否真实，不验证请求与响应作用域是否语义一致，也不限制状态字段到预设枚举。

`text` 应为准入的完整可展示原文，保留换行，不返回模型生成的摘要替代原文。若案例只允许返回经审核的脱敏展示文本，须在 `provenance` 清楚标明其性质和审核限制；不能声称它就是未修改原件。服务不得把凭据、SSH 信息、本机绝对路径或未授权的案件信息放入 metadata、错误响应及日志。适配器并不自动进行脱敏。

### 空结果与精确引用守卫

指定法名、条号或版本的原文查询若未取得准入文档，服务可返回 `documents: []`、`reference_guard: true`，并通过 `evidence_status` / `warnings` 说明未收录、作用域需澄清或禁止展示等实际原因。Agent 会标记 `completed_exact_reference_gap`，不自动换关键词或用其他法规顶替。普通查询的空结果使用 `reference_guard: false`，标记 `completed_no_candidates`。

这个守卫依赖服务提供的 trace；适配器自身不识别法名条号，也不实现 dense、BM25、RRF、精确条号路由或法律适用算法。空结果不证明现实中没有相应法律规则。

### 失败行为

非 2xx 状态、网络错误、超时、重定向、无响应正文、非法 JSON、超出协议边界均抛出工具错误。可以使用 400 表示非法请求、503 表示服务或索引未就绪。适配器不读取非成功响应中的错误正文。

搜索包含读响应正文在内的总等待上限为 20 秒，并转发调用方的 AbortSignal。响应流累计超过 2 MiB 会取消读取并报错。失败响应不会被替换成成功空结果，不生成知识来源快照；已保存的旧来源仍可读取。

## 5. 快照与引用语义

成功文档写入案件目录中的 `.legalagent/rag/sources/K_<sha256>.json`。此目录是运行产物，不应提交到 Git。快照保存完整原文、metadata、document_id，以及 index.fingerprint / index.as_of；检索预览不代替快照内容。

`K_` 的 SHA-256 是规范化后的 `version: 1` 快照 JSON 内容哈希，不是服务签名、原件鉴定或法规效力证明。文本、版本字段或索引标识变化会产生新 ID。写入采用排他创建并同步落盘，不覆盖已有快照；复读时重新校验哈希，并拒绝链接、junction 或不受控文件。它能发现快照被修改，不能证明服务原始数据可信、索引内部内容匹配 fingerprint，或来源截至时间真实。

`S...` 来源是本案导入登记材料，`K_...` 来源是外部知识缓存；外部案例不能直接登记成本案已记录事实。知识文本使用虚拟 `p0001` 页，行号来自缓存文本的全局物理行。例如第二行的 `start_line: 2` 对应 `p0001:L0002`。这些编号不是原 PDF 页码。对本案材料，读取参数同样使用提取输出文件的全局物理行，而 `[pXXXX:LXXXX]` 是提取器给出的页内定位标签，二者在多页材料中不一定相等。

检索每项原文预览最多 600 字符，总序列化工具输出最多 3,500 字符；JSON 转义和 metadata 也计入预算，因此实际展示可能少于 `limit`。省略或截断会标记，不能据此声称整份材料已读。需使用 `legal_source_read` 根据来源 ID、物理行及续读列读取完整内容，再用 `legal_citation_verify` 检查逐字引文存在性。引用检查不判断语义支持、证据真实性或法律适用正确性。

本包的定向测试使用合成规范、合成案件文本和临时本机 HTTP 服务。它们证明适配器协议、配置边界、错误行为及快照完整性，不证明任何实际法律语料的召回率或法律回答准确率。
