// Compiled against the packed `.d.ts` files by scripts/smoke-pack.mjs (R7). Must not use vendor SDK types.
import { createModel, createTool, Agent, MemoryDocStore, SpendTracker, TraceCollector, schema } from '@webergency-utils/ai';
import type { LanguageModel, ModelRequest, ModelResponse, ModelCapabilities } from '@webergency-utils/ai';
import { AIError } from '@webergency-utils/ai/core';
import { OpenAIProviderAdapter } from '@webergency-utils/ai/providers';
import { MemoryDocStore as Store } from '@webergency-utils/ai/storage';
import { MCPClient, MCPServer } from '@webergency-utils/ai/mcp';
import { SpendTracker as Tracker } from '@webergency-utils/ai/spend';
import { Agent as A, createTool as tool } from '@webergency-utils/ai/agent';
import { Workflow } from '@webergency-utils/ai/workflow';
import { TraceCollector as Collector, exportTraceToOTLP } from '@webergency-utils/ai/trace';
import pkg from '@webergency-utils/ai/package.json' with { type: 'json' };

const model: LanguageModel = createModel( { provider : 'openai', model : 'gpt-4o', apiKey : 'k' } );
const request: ModelRequest = { messages : [ { role : 'user', content : 'hi' } ] };
const pending: Promise<ModelResponse> = model.generate( request );
const caps: ModelCapabilities | undefined = model.capabilities;

const echo = createTool<{ text: string }, string>( {
    name        : 'echo',
    description : 'Echo text',
    parameters  : { type : 'object', properties : { text : { type : 'string' } }, required : [ 'text' ] },
    execute     : async ( args ) => args.text
} );

const agent = new Agent( { model, tools : [ echo ], instructions : 'be brief' } );

export const used = [ pending, caps, agent, MemoryDocStore, SpendTracker, TraceCollector, schema, AIError, OpenAIProviderAdapter, Store, MCPClient, MCPServer, Tracker, A, tool, Workflow, Collector, exportTraceToOTLP, pkg.version ];
