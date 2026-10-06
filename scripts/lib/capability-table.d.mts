export const START: string;
export const END: string;
export function renderCapabilityTable( byProvider: Record<string, { structuredOutput: boolean, embeddings: boolean, reasoningContent: boolean, promptCacheControl: boolean, multimodal: Record<string, boolean> }> ): string;
export function replaceBlock( markdown: string, table: string ): string;
