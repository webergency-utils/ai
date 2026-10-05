import { OpenAIProviderAdapter } from './openai.js';
import type { ChatMessage, ModelCapabilities, ModelConfig } from '../core/types.js';
import { InvalidInputError } from '../core/error.js';

export class DeepSeekProviderAdapter extends OpenAIProviderAdapter
{
    constructor( config: ModelConfig )
    {
        super( {
            ...config,
            provider : 'deepseek',
            baseUrl  : config.baseUrl ?? 'https://api.deepseek.com'
        } );
    }

    protected override get defaultEnvVar(): string
    {
        return 'DEEPSEEK_API_KEY';
    }

    protected override get echoesReasoningContent(): boolean
    {
        return true;
    }

    /** Thinking models reject tool-call follow-ups that omit the prior `reasoning_content`. */
    protected get requiresReasoningEcho(): boolean
    {
        return /reasoner/i.test( this.model ) || Boolean( this.config.vendorOptions?.thinking );
    }

    protected override formatSingleMessage( msg: ChatMessage ): Record<string, unknown>
    {
        if( this.requiresReasoningEcho 
            && msg.role === 'assistant' 
            && msg.toolCalls && msg.toolCalls.length > 0 
            && msg.reasoningContent === undefined )
        {
            throw new InvalidInputError( 
                `[deepseek] Assistant tool-call message is missing reasoningContent, which '${this.model}' requires to be echoed back as reasoning_content` 
            );
        }

        return super.formatSingleMessage( msg );
    }

    protected override get structuredWireFormat(): 'json_schema' | 'json_object'
    {
        return 'json_object';
    }

    protected override get defaultCapabilities(): ModelCapabilities
    {
        return {
            structuredOutput   : true,
            embeddings         : false,
            reasoningContent   : true,
            promptCacheControl : false,
            multimodal         : { image : false, audio : false, video : false, document : false }
        };
    }

    protected override get supportsPromptCacheKey(): boolean
    {
        return false;
    }
}
