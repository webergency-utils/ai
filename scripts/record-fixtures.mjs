#!/usr/bin/env node
// Re-runs the live provider suite in record mode and rewrites tests/fixtures/recorded/**.
// Needs real provider keys (see README "Live provider tests"). Usage:
//   npm run record:fixtures                     # every provider that has credentials
//   npm run record:fixtures -- --provider openai
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const argv = process.argv.slice( 2 );
const providerIndex = argv.indexOf( '--provider' );
const env = { ...process.env, AI_LIVE : '1', AI_RECORD : '1' };

if( providerIndex >= 0 )
{
    env.AI_LIVE_PROVIDER = argv[providerIndex + 1];
    env.AI_LIVE_REQUIRE ??= env.AI_LIVE_PROVIDER;
}

console.log( 'record-fixtures: running the live suite in record mode (this calls real provider APIs and costs money)' );

const result = spawnSync( process.platform === 'win32' ? 'npx.cmd' : 'npx', [ 'vitest', 'run', '--config', 'vitest.live.config.ts' ], { cwd : root, env, stdio : 'inherit', shell : process.platform === 'win32' } );

process.exit( result.status ?? 1 );
