export const ALLOWED: string[];
export const DENIED: { name: string, test: ( path: string ) => boolean }[];
export function checkPackFiles( files: string[], options?: { read?: ( file: string ) => string | undefined } ): string[];
