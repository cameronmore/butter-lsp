import {
	CompletionItem,
	CompletionItemKind,
	CompletionParams,
	createConnection,
	Diagnostic,
	DiagnosticSeverity,
	DocumentSymbol,
	DocumentSymbolParams,
	Hover,
	InitializeParams,
	InitializeResult,
	Location,
	MarkupKind,
	ParameterInformation,
	ReferenceParams,
	ProposedFeatures,
	Range,
	TextEdit,
	SignatureHelp,
	SignatureHelpParams,
	SignatureInformation,
	SymbolKind,
	TextDocumentSyncKind,
	type DefinitionParams,
	type HoverParams,
} from 'vscode-languageserver/node.js';
import path from 'node:path';
import fs from 'node:fs';
import {
	TextDocuments,
} from 'vscode-languageserver/node.js';
import {
	TextDocument as TextDocumentModel,
} from 'vscode-languageserver-textdocument';
import { analyzeDocument, analyzePath, analyzeText } from './analyzer.js';
import type { AnalysisReport, ButterDiagnostic, Span, SymbolView } from './types.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocumentModel);
const COMPLETION_TRIGGER_CHARACTERS = ['.', '_', ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const STDLIB_AUTO_IMPORTS: Record<string, string> = {
	io: 'std/io',
	fs: 'std/fs',
	env: 'std/env',
	path: 'std/path',
	process: 'std/process',
	os: 'std/os',
};

let analyzerPath = process.env.BUTTER_ANALYZER || 'butter-analyzer';
const analysisCache = new Map<string, AnalysisReport>();
const moduleAnalysisCache = new Map<string, AnalysisReport>();

connection.onInitialize((params: InitializeParams): InitializeResult => {
	const maybePath = params.initializationOptions?.analyzerPath;
	if (typeof maybePath === 'string' && maybePath.length > 0) {
		analyzerPath = maybePath;
	}

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			hoverProvider: true,
			definitionProvider: true,
			documentSymbolProvider: true,
			referencesProvider: true,
			completionProvider: {
				triggerCharacters: COMPLETION_TRIGGER_CHARACTERS,
			},
			signatureHelpProvider: {
				triggerCharacters: ['(', ','],
			},
		},
	};
});

documents.onDidOpen(async (change) => {
	await refreshDocument(change.document);
});

documents.onDidChangeContent(async (change) => {
	await refreshDocument(change.document);
});

documents.onDidSave(async (change) => {
	await refreshDocument(change.document);
});

documents.onDidClose((change) => {
	analysisCache.delete(change.document.uri);
	connection.sendDiagnostics({ uri: change.document.uri, diagnostics: [] });
});

connection.onHover(async (params: HoverParams): Promise<Hover | null> => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return null;

	const report = await getOrAnalyze(document);

	const offset = document.offsetAt(params.position);
	const symbol = findSymbolForOffset(report, offset) ?? await resolveImportedMemberSymbol(document, report, offset);
	if (!symbol) return null;

	return {
		contents: {
			kind: MarkupKind.Markdown,
			value: renderHover(symbol),
		},
		range: '__path' in symbol ? undefined : toRange(document, symbol.span),
	};
});

connection.onDefinition(async (params: DefinitionParams): Promise<Location | null> => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return null;

	const report = await getOrAnalyze(document);

	const offset = document.offsetAt(params.position);
	const symbol = findSymbolForOffset(report, offset);
	if (symbol) {
		return Location.create(document.uri, toRange(document, symbol.span));
	}

	const imported = await resolveImportedMemberSymbol(document, report, offset);
	if (!imported) return null;

	return Location.create(pathToUri(imported.__path), toRangeForPath(imported.__path, imported.span));
});

connection.onDocumentSymbol(async (params: DocumentSymbolParams): Promise<DocumentSymbol[]> => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];

	const report = await getOrAnalyze(document);

	const moduleScope = report.scopes.find((scope) => scope.kind === 'module');
	if (!moduleScope) return [];

	return report.symbols
		.filter((symbol) => symbol.scope_id === moduleScope.id)
		.map((symbol) => DocumentSymbol.create(
			symbol.name,
			renderSymbolDetail(symbol),
			toDocumentSymbolKind(symbol.kind),
			toRange(document, symbol.span),
			toRange(document, symbol.span),
		));
});

connection.onReferences(async (params: ReferenceParams): Promise<Location[]> => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];

	const report = await getOrAnalyze(document);
	const offset = document.offsetAt(params.position);
	const symbol = findSymbolForOffset(report, offset);
	if (!symbol) return [];

	const locations: Location[] = [];

	if (params.context.includeDeclaration) {
		locations.push(Location.create(document.uri, toRange(document, symbol.span)));
	}

	for (const reference of report.references) {
		if (reference.symbol_id !== symbol.id) continue;
		locations.push(Location.create(document.uri, toRange(document, reference.span)));
	}

	return locations;
});

connection.onCompletion(async (params: CompletionParams): Promise<CompletionItem[]> => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return [];

	let report = await getOrAnalyze(document);
	const offset = document.offsetAt(params.position);
	report = await getInteractiveReadyAnalysis(document, offset, report);
	const memberContext = findMemberAccessContext(document.getText(), offset);

	if (memberContext) {
		let objectSymbol = findVisibleSymbolByName(report, memberContext.objectName, memberContext.objectSpan.start);
		if (!objectSymbol) {
			const importPath = STDLIB_AUTO_IMPORTS[memberContext.objectName];
			if (!importPath) return [];
			const exportedSymbols = stdModuleSymbols(importPath);
			if (!exportedSymbols) return [];
			return exportedSymbols
				.filter((symbol) => symbol.visibility === 'public')
				.filter((symbol) => symbol.name.startsWith(memberContext.memberPrefix))
				.map((symbol) => toCompletionItem(symbol, document, {
					alias: memberContext.objectName,
					importPath,
				}));
		}
		const exportedSymbols = await getImportedModuleSymbols(document, objectSymbol);
		if (!exportedSymbols) return [];

		return exportedSymbols
			.filter((symbol) => symbol.visibility === 'public')
			.filter((symbol) => symbol.name.startsWith(memberContext.memberPrefix))
			.map((symbol) => toCompletionItem(symbol));
	}

	const prefix = currentIdentifierPrefix(document.getText(), offset);
	const items = getCompletionSymbols(report, offset, prefix).map((symbol) => toCompletionItem(symbol));
	for (const [alias, importPath] of Object.entries(STDLIB_AUTO_IMPORTS)) {
		if (prefix.length === 0 || !alias.startsWith(prefix)) continue;
		if (findVisibleSymbolByName(report, alias, offset)) continue;
		items.push(makeStdlibAliasCompletion(alias, importPath, document));
	}
	return items;
});

connection.onSignatureHelp(async (params: SignatureHelpParams): Promise<SignatureHelp | null> => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return null;

	const initialReport = await getOrAnalyze(document);
	const offset = document.offsetAt(params.position);
	const context = findCallContext(document.getText(), offset);
	if (!context) return null;

	const report = await getInteractiveReadyAnalysis(document, offset, initialReport);
	const target = await resolveCallable(document, report, context.calleeText, context.calleeOffset);
	if (!target || !target.signature) return null;

	const parameterInfos = buildParameterInfos(target.signature, target.parameter_names ?? []);
	return {
		signatures: [
			SignatureInformation.create(
				target.signature,
				target.doc ? renderDoc(target.doc) : undefined,
				...parameterInfos,
			),
		],
		activeSignature: 0,
		activeParameter: Math.min(context.activeParameter, Math.max(parameterInfos.length - 1, 0)),
	};
});

async function refreshDocument(document: TextDocumentModel): Promise<void> {
	try {
		const report = await analyzeDocument(document, analyzerPath);
		analysisCache.set(document.uri, report);
		connection.sendDiagnostics({
			uri: document.uri,
			diagnostics: report.diagnostics.map((diagnostic) => toDiagnostic(document, diagnostic)),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		connection.console.error(message);
	}
}

async function getOrAnalyze(document: TextDocumentModel): Promise<AnalysisReport> {
	const cached = analysisCache.get(document.uri);
	if (cached) return cached;

	const report = await analyzeDocument(document, analyzerPath);
	analysisCache.set(document.uri, report);
	return report;
}

async function getInteractiveReadyAnalysis(
	document: TextDocumentModel,
	offset: number,
	report: AnalysisReport,
): Promise<AnalysisReport> {
	if (report.symbols.length > 0 || report.scopes.length > 0) return report;

	const sanitized = sanitizeForInteractive(document.getText(), offset);
	if (!sanitized) return report;

	try {
		return await analyzeText(filePathFromUri(document.uri), sanitized, analyzerPath);
	} catch {
		return report;
	}
}

function findSymbolForOffset(report: AnalysisReport, offset: number): SymbolView | null {
	const directSymbol = report.symbols.find((symbol) => containsOffset(symbol.span, offset));
	if (directSymbol) return directSymbol;

	const ref = report.references.find((reference) => containsOffset(reference.span, offset));
	if (!ref || ref.symbol_id == null) return null;

	return report.symbols.find((symbol) => symbol.id === ref.symbol_id) ?? null;
}

function sanitizeForInteractive(text: string, offset: number): string | null {
	const prefix = text.slice(0, offset);
	const memberContext = findMemberAccessContext(prefix, prefix.length);
	if (memberContext) {
		const placeholder = '__butter_complete__';
		const beforeMember = prefix.slice(0, memberContext.memberSpan.start);
		return `${beforeMember}${placeholder}${missingClosers(prefix)};`;
	}

	if (findCallContext(prefix, prefix.length)) {
		return `${prefix}${missingClosers(prefix)};`;
	}

	if (!prefix.trim()) return null;
	return `${prefix}${missingClosers(prefix)};`;
}

function missingClosers(text: string): string {
	let parens = 0;
	let brackets = 0;
	let braces = 0;
	let inString = false;
	let escaping = false;

	for (const ch of text) {
		if (inString) {
			if (escaping) {
				escaping = false;
				continue;
			}
			if (ch === '\\') {
				escaping = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === '(') parens += 1;
		else if (ch === ')') parens = Math.max(0, parens - 1);
		else if (ch === '[') brackets += 1;
		else if (ch === ']') brackets = Math.max(0, brackets - 1);
		else if (ch === '{') braces += 1;
		else if (ch === '}') braces = Math.max(0, braces - 1);
	}

	return ')'.repeat(parens) + ']'.repeat(brackets) + '}'.repeat(braces);
}

function renderHover(symbol: SymbolView): string {
	const signature = renderHoverSignature(symbol);
	const parts: string[] = [];
	if (symbol.doc) {
		parts.push(renderDoc(symbol.doc));
	}
	parts.push(`\`\`\`butter\n${signature}\n\`\`\``);
	return parts.join('\n\n');
}

function buildParameterInfos(signature: string, parameterNames: string[]): ParameterInformation[] {
	const ranges = parameterLabelRanges(signature);
	if (ranges.length > 0) {
		return ranges.map((range, index) =>
			ParameterInformation.create(
				range,
				parameterNames[index],
			),
		);
	}

	return parameterNames.map((name) => ParameterInformation.create(name));
}

function parameterLabelRanges(signature: string): Array<[number, number]> {
	const open = signature.indexOf('(');
	if (open < 0) return [];

	let close = -1;
	let bracketDepth = 0;
	for (let i = open + 1; i < signature.length; i += 1) {
		const ch = signature[i];
		if (ch === '[') bracketDepth += 1;
		else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
		else if (ch === ')' && bracketDepth === 0) {
			close = i;
			break;
		}
	}
	if (close < 0 || close === open + 1) return [];

	const ranges: Array<[number, number]> = [];
	let start = open + 1;
	let depth = 0;

	for (let i = open + 1; i <= close; i += 1) {
		const ch = signature[i];
		if (ch === '[') depth += 1;
		else if (ch === ']') depth = Math.max(0, depth - 1);

		const atBoundary = i === close || (ch === ',' && depth === 0);
		if (!atBoundary) continue;

		let partEnd = i;
		while (start < partEnd && signature[start] === ' ') start += 1;
		while (partEnd > start && signature[partEnd - 1] === ' ') partEnd -= 1;
		if (partEnd > start) {
			ranges.push([start, partEnd]);
		}
		start = i + 1;
	}

	return ranges;
}

function renderHoverSignature(symbol: SymbolView): string {
	if (!symbol.signature) {
		return `${symbol.visibility === 'public' ? 'pub ' : ''}${renderSymbolDetail(symbol)} ${symbol.name}`;
	}

	switch (symbol.kind) {
		case 'let_binding':
		case 'const_binding':
		case 'parameter':
			return `${symbol.signature} ${symbol.name}`;
		case 'error_tag':
			return symbol.signature.startsWith('error ') ? symbol.signature : `error ${symbol.name}`;
		case 'function':
			return symbol.signature;
	}
}

function renderSymbolDetail(symbol: SymbolView): string {
	switch (symbol.kind) {
		case 'function':
			return 'fn';
		case 'const_binding':
			return 'const';
		case 'let_binding':
			return 'let';
		case 'parameter':
			return 'param';
		case 'error_tag':
			return 'error';
	}
}

function toDiagnostic(document: TextDocumentModel, diagnostic: ButterDiagnostic): Diagnostic {
	return {
		severity: toDiagnosticSeverity(diagnostic.severity),
		range: toRange(document, diagnostic.span),
		message: diagnostic.message,
		source: 'butter-analyzer',
	};
}

function toDiagnosticSeverity(severity: ButterDiagnostic['severity']): DiagnosticSeverity {
	switch (severity) {
		case 'info_severity':
			return DiagnosticSeverity.Information;
		case 'warning_severity':
			return DiagnosticSeverity.Warning;
		case 'error_severity':
			return DiagnosticSeverity.Error;
	}
}

function toDocumentSymbolKind(kind: SymbolView['kind']): SymbolKind {
	switch (kind) {
		case 'function':
			return SymbolKind.Function;
		case 'error_tag':
			return SymbolKind.EnumMember;
		case 'parameter':
			return SymbolKind.Variable;
		case 'let_binding':
		case 'const_binding':
			return SymbolKind.Variable;
	}
}

function toCompletionItem(
	symbol: SymbolView,
	document?: TextDocumentModel,
	autoImport?: { alias: string; importPath: string },
): CompletionItem {
	const item: CompletionItem = {
		label: symbol.name,
		kind: toCompletionItemKind(symbol.kind),
		detail: symbol.signature ?? renderSymbolDetail(symbol),
		documentation: symbol.doc ? renderDoc(symbol.doc) : undefined,
		filterText: symbol.name,
		insertText: symbol.name,
	};
	if (document && autoImport) {
		item.additionalTextEdits = buildStdlibImportEdit(document, autoImport.alias, autoImport.importPath);
		item.detail = `${item.detail ?? ''} (auto-import ${autoImport.importPath})`.trim();
		item.sortText = `0_${symbol.name}`;
	}
	return item;
}

function toCompletionItemKind(kind: SymbolView['kind']): CompletionItemKind {
	switch (kind) {
		case 'function':
			return CompletionItemKind.Function;
		case 'error_tag':
			return CompletionItemKind.EnumMember;
		case 'parameter':
			return CompletionItemKind.Variable;
		case 'let_binding':
		case 'const_binding':
			return CompletionItemKind.Variable;
	}
}

function toRange(document: TextDocumentModel, span: Span): Range {
	return Range.create(document.positionAt(span.start), document.positionAt(span.end));
}

function containsOffset(span: Span, offset: number): boolean {
	return offset >= span.start && offset < span.end;
}

function filePathFromUri(uri: string): string {
	return uri.startsWith('file://') ? decodeURIComponent(new URL(uri).pathname) : uri;
}

function pathToUri(filePath: string): string {
	return new URL(`file://${filePath}`).toString();
}

function toRangeForPath(filePath: string, span: Span): Range {
	const text = fs.readFileSync(filePath, 'utf8');
	const doc = TextDocumentModel.create(pathToUri(filePath), 'butter', 0, text);
	return toRange(doc, span);
}

function getVisibleSymbols(report: AnalysisReport, offset: number): SymbolView[] {
	const scope = innermostScope(report, offset);
	const visibleScopeIds = new Set<number>();
	let current = scope?.id ?? null;
	while (current != null) {
		visibleScopeIds.add(current);
		current = report.scopes.find((item) => item.id === current)?.parent ?? null;
	}
	return report.symbols.filter((symbol) => visibleScopeIds.has(symbol.scope_id));
}

function getCompletionSymbols(report: AnalysisReport, offset: number, prefix: string): SymbolView[] {
	const visible = getVisibleSymbols(report, offset);
	const seen = new Set<string>();
	const filtered = prefix.length > 0
		? visible.filter((symbol) => symbol.name.startsWith(prefix))
		: visible;

	const deduped: SymbolView[] = [];
	for (const symbol of filtered) {
		if (seen.has(symbol.name)) continue;
		seen.add(symbol.name);
		deduped.push(symbol);
	}

	return deduped;
}

function findVisibleSymbolByName(report: AnalysisReport, name: string, offset: number): SymbolView | null {
	const scope = innermostScope(report, offset);
	if (!scope) return report.symbols.find((symbol) => symbol.name === name) ?? null;

	let current: number | null = scope.id;
	while (current != null) {
		const found = report.symbols.find((symbol) => symbol.name === name && symbol.scope_id === current);
		if (found) return found;
		current = report.scopes.find((item) => item.id === current)?.parent ?? null;
	}

	return report.symbols.find((symbol) => symbol.name === name && symbol.scope_id === 1) ?? null;
}

function currentIdentifierPrefix(text: string, offset: number): string {
	let start = offset;
	while (start > 0 && isIdentChar(text[start - 1])) start -= 1;
	return text.slice(start, offset);
}

function makeStdlibAliasCompletion(alias: string, importPath: string, document: TextDocumentModel): CompletionItem {
	return {
		label: alias,
		kind: CompletionItemKind.Module,
		detail: `const ${alias} = import("${importPath}")`,
		filterText: alias,
		insertText: alias,
		additionalTextEdits: buildStdlibImportEdit(document, alias, importPath),
		sortText: `1_${alias}`,
	};
}

function innermostScope(report: AnalysisReport, offset: number) {
	let best: AnalysisReport['scopes'][number] | null = null;
	for (const scope of report.scopes) {
		if (!containsOffset(scope.span, offset) && offset !== scope.span.end) continue;
		if (!best || (scope.span.end - scope.span.start) < (best.span.end - best.span.start)) {
			best = scope;
		}
	}
	return best;
}

type MemberAccessContext = {
	objectName: string;
	objectSpan: Span;
	memberPrefix: string;
	memberSpan: Span;
};

function findMemberAccessContext(text: string, offset: number): MemberAccessContext | null {
	let memberStart = offset;
	while (memberStart > 0 && isIdentChar(text[memberStart - 1])) memberStart -= 1;
	let memberEnd = offset;
	while (memberEnd < text.length && isIdentChar(text[memberEnd])) memberEnd += 1;

	const dotIndex = memberStart - 1;
	if (dotIndex < 0 || text[dotIndex] !== '.') return null;

	let objectEnd = dotIndex;
	let objectStart = objectEnd;
	while (objectStart > 0 && isIdentChar(text[objectStart - 1])) objectStart -= 1;
	if (objectStart === objectEnd) return null;

	return {
		objectName: text.slice(objectStart, objectEnd),
		objectSpan: { start: objectStart, end: objectEnd },
		memberPrefix: text.slice(memberStart, memberEnd),
		memberSpan: { start: memberStart, end: memberEnd },
	};
}

function isIdentChar(ch: string | undefined): boolean {
	return !!ch && !/[\s()[\]{};,:.+\-*/%!=<>]/.test(ch);
}

type ImportedSymbol = SymbolView & { __path: string };
type StdModuleSymbolSpec = {
	name: string;
	signature: string;
	kind: SymbolView['kind'];
	doc?: string | null;
	parameter_names?: string[];
};

const STD_MODULE_EXPORTS: Record<string, StdModuleSymbolSpec[]> = {
	'std/io': [
		{ name: 'writeln', signature: 'fn writeln(value)', kind: 'function', parameter_names: ['value'] },
		{ name: 'write', signature: 'fn write(value)', kind: 'function', parameter_names: ['value'] },
		{ name: 'println', signature: 'fn println(value)', kind: 'function', parameter_names: ['value'] },
		{ name: 'print', signature: 'fn print(value)', kind: 'function', parameter_names: ['value'] },
	],
	'std/fs': [
		{ name: 'readFile', signature: 'fn readFile(path) -> string, error', kind: 'function', parameter_names: ['path'] },
		{ name: 'writeFile', signature: 'fn writeFile(path, content) -> nil, error', kind: 'function', parameter_names: ['path', 'content'] },
		{ name: 'readDirectory', signature: 'fn readDirectory(path) -> [string], error', kind: 'function', parameter_names: ['path'] },
		{ name: 'exists', signature: 'fn exists(path) -> bool', kind: 'function', parameter_names: ['path'] },
		{ name: 'ReadFileError', signature: 'error ReadFileError', kind: 'error_tag' },
		{ name: 'WriteFileError', signature: 'error WriteFileError', kind: 'error_tag' },
		{ name: 'ReadDirectoryError', signature: 'error ReadDirectoryError', kind: 'error_tag' },
	],
	'std/env': [
		{ name: 'get', signature: 'fn get(name) -> string', kind: 'function', parameter_names: ['name'] },
	],
	'std/path': [
		{ name: 'join', signature: 'fn join(a, b)', kind: 'function', parameter_names: ['a', 'b'] },
		{ name: 'basename', signature: 'fn basename(path)', kind: 'function', parameter_names: ['path'] },
		{ name: 'dirname', signature: 'fn dirname(path)', kind: 'function', parameter_names: ['path'] },
		{ name: 'extname', signature: 'fn extname(path)', kind: 'function', parameter_names: ['path'] },
	],
	'std/process': [
		{ name: 'args', signature: 'fn args() -> [string]', kind: 'function', parameter_names: [] },
		{ name: 'id', signature: 'fn id() -> int', kind: 'function', parameter_names: [] },
		{ name: 'exit', signature: 'fn exit(code)', kind: 'function', parameter_names: ['code'] },
	],
	'std/os': [
		{ name: 'cwd', signature: 'fn cwd() -> string, error', kind: 'function', parameter_names: [] },
		{ name: 'name', signature: 'fn name() -> string', kind: 'function', parameter_names: [] },
		{ name: 'arch', signature: 'fn arch() -> string', kind: 'function', parameter_names: [] },
		{ name: 'CwdError', signature: 'error CwdError', kind: 'error_tag' },
	],
};

function stdModuleSymbols(importPath: string): ImportedSymbolList | null {
	if (!STD_MODULE_EXPORTS[importPath]) return null;
	const builtins = STD_MODULE_EXPORTS[importPath].map((item, index) => ({
		id: -100 - index,
		name: item.name,
		kind: item.kind,
		scope_id: 0,
		node_id: 0,
		span: { start: 0, end: 0 },
		visibility: 'public' as const,
		signature: item.signature,
		doc: item.doc ?? null,
		parameter_names: item.parameter_names ?? null,
		import_path: null,
	})) as ImportedSymbolList;
	builtins.__path = importPath;
	return builtins;
}

async function resolveImportedMemberSymbol(
	document: TextDocumentModel,
	report: AnalysisReport,
	offset: number,
): Promise<ImportedSymbol | null> {
	const memberContext = findMemberAccessContext(document.getText(), offset);
	if (!memberContext) return null;

	if (offset < memberContext.memberSpan.start || offset > memberContext.memberSpan.end) return null;

	const objectSymbol = findVisibleSymbolByName(report, memberContext.objectName, memberContext.objectSpan.start);
	if (!objectSymbol) return null;
	const exportedSymbols = await getImportedModuleSymbols(document, objectSymbol);
	if (!exportedSymbols) return null;
	const memberName = memberContext.memberPrefix || document.getText().slice(memberContext.memberSpan.start, memberContext.memberSpan.end);
	const found = exportedSymbols.find((symbol) => symbol.name === memberName && symbol.visibility === 'public');
	return found ? { ...found, __path: exportedSymbols.__path } : null;
}

type ImportedSymbolList = SymbolView[] & { __path: string };

async function getImportedModuleSymbols(document: TextDocumentModel, symbol: SymbolView): Promise<ImportedSymbolList | null> {
	const importPath = symbol.import_path;
	if (!importPath) return null;

	if (STD_MODULE_EXPORTS[importPath]) return stdModuleSymbols(importPath);

	const containingPath = filePathFromUri(document.uri);
	const resolvedPath = resolveImportSpecifier(importPath, containingPath);
	if (!resolvedPath) return null;

	const openDoc = documents.all().find((item) => filePathFromUri(item.uri) === resolvedPath);
	const importedReport = openDoc
		? await analyzeDocument(openDoc, analyzerPath)
		: await getOrAnalyzePath(resolvedPath);

	const symbols = importedReport.symbols.filter((item) => item.visibility === 'public') as ImportedSymbolList;
	symbols.__path = importedReport.path;
	return symbols;
}

async function getOrAnalyzePath(filePath: string): Promise<AnalysisReport> {
	const cached = moduleAnalysisCache.get(filePath);
	if (cached) return cached;
	const report = await analyzePath(filePath, analyzerPath);
	moduleAnalysisCache.set(filePath, report);
	return report;
}

function resolveImportSpecifier(specifier: string, containingFilePath: string): string | null {
	if (STD_MODULE_EXPORTS[specifier]) return specifier;
	if (path.isAbsolute(specifier)) return pickExistingImportPath(specifier);

	const baseDir = path.dirname(containingFilePath);
	if (specifier.startsWith('./') || specifier.startsWith('../')) {
		return pickExistingImportPath(path.resolve(baseDir, specifier));
	}

	for (const searchDir of ancestorDirs(baseDir)) {
		const found = pickExistingImportPath(path.resolve(searchDir, specifier));
		if (found) return found;
	}

	return null;
}

function ancestorDirs(startDir: string): string[] {
	const dirs: string[] = [];
	let current = path.resolve(startDir);

	while (true) {
		dirs.push(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return dirs;
}

function pickExistingImportPath(base: string): string | null {
	const candidates = [
		base,
		`${base}.butter`,
		path.join(base, 'main.butter'),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return null;
}

function buildStdlibImportEdit(document: TextDocumentModel, alias: string, importPath: string): TextEdit[] {
	const text = document.getText();
	const importLine = `const ${alias} = import("${importPath}");\n`;
	if (text.includes(importLine.trim())) return [];

	const offset = importInsertionOffset(text);
	const position = document.positionAt(offset);
	return [TextEdit.insert(position, importLine)];
}

function importInsertionOffset(text: string): number {
	const importLine = /^(?:let|const)\s+[A-Za-z_\x80-\u{10FFFF}][A-Za-z0-9_\x80-\u{10FFFF}]*\s*=\s*import\(".*"\);\s*$/u;
	let offset = 0;
	let index = 0;
	const lines = text.split('\n');

	while (index < lines.length) {
		const line = lines[index];
		const trimmed = line.trim();
		const lineLength = line.length + 1;

		if (trimmed === '') {
			offset += lineLength;
			index += 1;
			continue;
		}

		if (trimmed.startsWith('///')) {
			break;
		}

		if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
			offset += lineLength;
			index += 1;
			continue;
		}

		break;
	}

	while (index < lines.length) {
		const line = lines[index];
		if (!importLine.test(line.trim())) break;
		offset += line.length + 1;
		index += 1;
	}

	return offset;
}

function renderDoc(doc: string): string {
	return doc
		.split('\n')
		.map((line) => line.replace(/^\s*\/\/\/\s?/, ''))
		.join('\n')
		.trim();
}

type CallContext = {
	calleeText: string;
	calleeOffset: number;
	activeParameter: number;
};

function findCallContext(text: string, offset: number): CallContext | null {
	let depth = 0;
	let activeParameter = 0;

	for (let i = offset - 1; i >= 0; i -= 1) {
		const ch = text[i];
		if (ch === ')') {
			depth += 1;
		} else if (ch === '(') {
			if (depth === 0) {
				let end = i;
				while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
				let start = end;
				while (start > 0 && isIdentChar(text[start - 1])) start -= 1;
				return {
					calleeText: text.slice(start, end),
					calleeOffset: start,
					activeParameter,
				};
			}
			depth -= 1;
		} else if (ch === ',' && depth === 0) {
			activeParameter += 1;
		}
	}

	return null;
}

async function resolveCallable(
	document: TextDocumentModel,
	report: AnalysisReport,
	calleeText: string,
	calleeOffset: number,
): Promise<SymbolView | ImportedSymbol | null> {
	const dotIndex = calleeText.lastIndexOf('.');
	if (dotIndex >= 0) {
		const objectName = calleeText.slice(0, dotIndex);
		const memberName = calleeText.slice(dotIndex + 1);
		const objectSymbol = findVisibleSymbolByName(report, objectName, calleeOffset);
		if (!objectSymbol) return null;
		const importedSymbols = await getImportedModuleSymbols(document, objectSymbol);
		if (!importedSymbols) return null;
		const found = importedSymbols.find((symbol) => symbol.name === memberName);
		return found ? { ...found, __path: importedSymbols.__path } : null;
	}

	return findVisibleSymbolByName(report, calleeText, calleeOffset);
}

documents.listen(connection);
connection.listen();
