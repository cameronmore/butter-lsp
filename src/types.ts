export type Span = {
	start: number;
	end: number;
};

export type ButterDiagnostic = {
	severity: 'info_severity' | 'warning_severity' | 'error_severity';
	message: string;
	span: Span;
};

export type Scope = {
	id: number;
	parent: number | null;
	kind: 'module' | 'function' | 'block';
	span: Span;
};

export type SymbolKind =
	| 'let_binding'
	| 'const_binding'
	| 'function'
	| 'parameter'
	| 'error_tag';

export type SymbolView = {
	id: number;
	name: string;
	kind: SymbolKind;
	scope_id: number;
	node_id: number;
	span: Span;
	visibility: 'private' | 'public';
	doc?: string | null;
	signature?: string | null;
	parameter_names?: string[] | null;
	import_path?: string | null;
};

export type ReferenceView = {
	node_id: number;
	span: Span;
	name: string;
	symbol_id: number | null;
};

export type AnalysisReport = {
	path: string;
	ok: boolean;
	diagnostics: ButterDiagnostic[];
	scopes: Scope[];
	symbols: SymbolView[];
	references: ReferenceView[];
};
