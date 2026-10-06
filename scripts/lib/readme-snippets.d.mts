export function extractSnippets( markdown: string ): { code: string, line: number }[];
export function mapDiagnostics( output: string, snippets: { line: number }[] ): string[];
