import { spawn } from 'node:child_process';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { AnalysisReport } from './types.js';

export async function analyzeDocument(document: TextDocument, analyzerPath: string): Promise<AnalysisReport> {
	const inputPath = document.uri.startsWith('file://')
		? decodeURIComponent(new URL(document.uri).pathname)
		: document.uri;
	const raw = await runAnalyzer(analyzerPath, inputPath, document.getText());
	return JSON.parse(raw) as AnalysisReport;
}

export async function analyzePath(inputPath: string, analyzerPath: string): Promise<AnalysisReport> {
	const raw = await runAnalyzer(analyzerPath, inputPath);
	return JSON.parse(raw) as AnalysisReport;
}

export async function analyzeText(inputPath: string, sourceText: string, analyzerPath: string): Promise<AnalysisReport> {
	const raw = await runAnalyzer(analyzerPath, inputPath, sourceText);
	return JSON.parse(raw) as AnalysisReport;
}

function runAnalyzer(analyzerPath: string, inputPath: string, sourceText?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const usingStdin = typeof sourceText === 'string';
		const child = spawn(analyzerPath, usingStdin ? ['--stdin', '--path', inputPath] : [inputPath], {
			stdio: [usingStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';

		child.stdout!.on('data', (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});

		child.stderr!.on('data', (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});

		if (usingStdin) {
			child.stdin!.write(sourceText);
			child.stdin!.end();
		}

		child.on('error', reject);

		child.on('close', (code) => {
			const output = stdout.trim().length > 0 ? stdout : stderr;

			if (code !== 0 && output.trim().length === 0) {
				reject(new Error(stderr || `butter-analyzer exited with code ${code}`));
				return;
			}
			resolve(output);
		});
	});
}
