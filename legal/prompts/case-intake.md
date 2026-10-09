---
description: 清点案件材料并形成事实、争点和缺口清单
argument-hint: "[案件目标或问题]"
---
请对当前案件进行材料初审。案件目标：${ARGUMENTS:-先识别材料和待办事项}。

1. 先用 `legal_case_status` 读取案件状态，再用 `legal_sources_list` 列出已预处理来源；若无来源，说明如何运行本仓库的 `legal/intake/intake.py`，不要假装已读材料。
2. 逐份读取与问题有关的内容，记录来源 ID、页码和行号。区分原始文件中的记载与用户补充陈述。
3. 输出：案件范围和法域待确认项、材料目录、已确认事实、相互矛盾的说法、关键争点、证据缺口及下一步核查顺序。
4. 不推定扫描件已完成 OCR，不编造法律依据。逐字引文先用 `legal_citation_verify` 核验。
5. 用 `legal_case_update` 保存 scope、分类事实和待办；没有证据的陈述保持 party_claim。根据产物实际齐备情况，用 `legal_case_advance` 推进到证据阶段或保存待补任务，不仅输出清单。
