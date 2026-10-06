export function checkRelease( input: { tag?: string, version: string, sha?: string, requireMain?: boolean, isOnMain?: ( sha: string ) => boolean } ): string[];
