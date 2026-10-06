export interface VitestJsonReport { testResults: { name: string, assertionResults: { status: string, fullName?: string, title?: string }[] }[] }
export function findUnexpectedSkips( report: VitestJsonReport, allow: { file: string }[], cwd?: string ): { file: string, test: string, status: string }[];
