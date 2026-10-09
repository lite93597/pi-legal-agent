export const STAGES = ["intake", "evidence", "analysis", "strategy", "draft", "review"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
	intake: "接案与范围",
	evidence: "材料与证据",
	analysis: "争点与依据",
	strategy: "方案与风险",
	draft: "文书草案",
	review: "待专业审阅",
};
export const WORKFLOW_TOOLS = [
	"legal_case_status",
	"legal_case_update",
	"legal_case_advance",
	"legal_draft_save",
] as const;

export interface SourceRef {
	source_id: string;
	start_line: number;
	end_line: number;
	/** Filled by the store; detects changed excerpts without claiming authenticity. */
	text_sha256?: string;
}

export interface CaseScope {
	objective: string;
	jurisdiction: string;
	procedure: string;
	legalAsOf: string;
}

export interface CaseFact {
	id: string;
	kind: "recorded" | "party_claim" | "inference";
	text: string;
	refs: SourceRef[];
	note: string;
}

export interface CaseIssue {
	id: string;
	question: string;
	forFacts: string[];
	againstFacts: string[];
	gaps: string[];
	analysis: string;
}

export interface CaseLaw {
	id: string;
	title: string;
	version: string;
	status: "pending" | "provided";
	refs: SourceRef[];
	note: string;
}

export interface CaseTask {
	id: string;
	title: string;
	status: "open" | "done";
	note: string;
}

export interface CaseStrategy {
	primary: string;
	alternative: string;
	risks: string;
	conditions: string;
}

export interface CaseDraft {
	filename: string;
	title: string;
	path: string;
	sha256: string;
	savedAt: string;
	refs: SourceRef[];
	unresolved: string[];
	reviewStatus: "awaiting_professional_review";
}

export interface CaseState {
	version: 1;
	revision: number;
	stage: Stage;
	updatedAt: string | null;
	scope: CaseScope;
	facts: CaseFact[];
	issues: CaseIssue[];
	laws: CaseLaw[];
	tasks: CaseTask[];
	strategy: CaseStrategy;
	drafts: CaseDraft[];
	sourceWarnings: string[];
}

export type UpdateSection = "scope" | "facts" | "issues" | "laws" | "tasks" | "strategy";
export interface CaseUpdate {
	section: UpdateSection;
	data: unknown;
}

export interface DraftInput {
	filename: string;
	title: string;
	content: string;
	refs: SourceRef[];
	unresolved: string[];
}
