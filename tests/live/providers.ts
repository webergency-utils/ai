import type { LiveProviderSpec } from './gating.js';

const env = process.env;

/** Cheapest sensible models; override per provider with `AI_LIVE_<PROVIDER>_MODEL`. */
export const LIVE_PROVIDERS: LiveProviderSpec[] =
    [
        { id : 'openai',    keyEnv : 'OPENAI_API_KEY',    model : env.AI_LIVE_OPENAI_MODEL    ?? 'gpt-4o-mini',          embeddingModel : env.AI_LIVE_OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small' },
        { id : 'anthropic', keyEnv : 'ANTHROPIC_API_KEY', model : env.AI_LIVE_ANTHROPIC_MODEL ?? 'claude-haiku-4-5' },
        { id : 'gemini',    keyEnv : 'GEMINI_API_KEY',    model : env.AI_LIVE_GEMINI_MODEL    ?? 'gemini-2.0-flash',     embeddingModel : env.AI_LIVE_GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001' },
        { id : 'groq',      keyEnv : 'GROQ_API_KEY',      model : env.AI_LIVE_GROQ_MODEL      ?? 'llama-3.1-8b-instant' },
        { id : 'mistral',   keyEnv : 'MISTRAL_API_KEY',   model : env.AI_LIVE_MISTRAL_MODEL   ?? 'mistral-small-latest' },
        { id : 'deepseek',  keyEnv : 'DEEPSEEK_API_KEY',  model : env.AI_LIVE_DEEPSEEK_MODEL  ?? 'deepseek-chat' },
        { id : 'ollama',    model : env.AI_LIVE_OLLAMA_MODEL ?? 'llama3.2', embeddingModel : env.AI_LIVE_OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text', baseUrl : env.OLLAMA_HOST ?? 'http://localhost:11434' }
    ];

export function providerSpec( id: string ): LiveProviderSpec
{
    const spec = LIVE_PROVIDERS.find( ( p ) => p.id === id );

    if( !spec )
    {
        throw new Error( `unknown live provider "${ id }"` );
    }

    return spec;
}
