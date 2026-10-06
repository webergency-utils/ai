import { REDIS_SCRIPTS } from '../../src/storage/index.js';
import type { RedisClient } from '../../src/storage/index.js';

export interface RedisCall
{
    kind   : 'eval' | 'get' | 'exists'
    script? : string
    keys   : string[]
    args   : string[]
}

/**
 * In-memory stand-in for a Redis connection. It does NOT run Lua: each exported script is re-implemented in JS with
 * the same observable semantics, so adapter logic (keys, argument order, reply parsing, TTL handling) is exercised
 * without a server. Real Lua behavior is covered by the env-gated suites against a live Redis.
 */
export class FakeRedis implements RedisClient
{
    public readonly calls : RedisCall[] = [];
    readonly #strings = new Map<string, { value: string, expiresAt?: number }>();
    readonly #sets    = new Map<string, Set<string>>();

    public async eval( script: string, keys: string[], args: string[] ): Promise<unknown>
    {
        this.calls.push( { kind : 'eval', script, keys : [ ...keys ], args : [ ...args ] } );

        const name = ( Object.keys( REDIS_SCRIPTS ) as Array<keyof typeof REDIS_SCRIPTS> ).find( ( k ) => {return REDIS_SCRIPTS[k] === script;} );

        if( !name ){throw new Error( 'ERR unknown script' );}

        // Yield like a network round trip so concurrent callers interleave realistically.
        await Promise.resolve();

        return this.#run( name, keys, args );
    }

    public async get( key: string ): Promise<string | null>
    {
        this.calls.push( { kind : 'get', keys : [ key ], args : [] } );

        return this.#read( key );
    }

    public async exists( keys: string[] ): Promise<number>
    {
        this.calls.push( { kind : 'exists', keys : [ ...keys ], args : [] } );

        return keys.filter( ( k ) => {return this.#read( k ) !== null;} ).length;
    }

    public keys(): string[]
    {
        return [ ...this.#strings.keys(), ...this.#sets.keys() ].sort();
    }

    #read( key: string ): string | null
    {
        const entry = this.#strings.get( key );

        if( !entry ){return null;}

        if( entry.expiresAt !== undefined && Date.now() >= entry.expiresAt )
        {
            this.#strings.delete( key );

            return null;
        }

        return entry.value;
    }

    #set( key: string ): Set<string>
    {
        let s = this.#sets.get( key );

        if( !s )
        {
            s = new Set<string>();
            this.#sets.set( key, s );
        }

        return s;
    }

    #sadd( key: string, member: string ): void
    {
        this.#set( key ).add( member );
    }

    #srem( key: string, member: string ): void
    {
        const s = this.#sets.get( key );

        s?.delete( member );

        if( s && s.size === 0 ){this.#sets.delete( key );}
    }

    #del( key: string ): number
    {
        const existed = this.#read( key ) !== null;

        this.#strings.delete( key );

        return existed ? 1 : 0;
    }

    #version( cur: string ): number
    {
        const m = /^{"version":(\d+)/.exec( cur );

        if( !m ){throw new Error( 'ERR corrupt envelope' );}

        return Number( m[1] );
    }

    #run( name: keyof typeof REDIS_SCRIPTS, keys: string[], args: string[] ): unknown
    {
        switch ( name )
        {
            case 'docSet':
            {
                const cur = this.#read( keys[0] );
                const v = cur === null ? 1 : this.#version( cur ) + 1;

                this.#strings.set( keys[0], { value : `{"version":${v},"doc":${args[0]}}` } );
                this.#sadd( keys[1], args[1] );
                this.#sadd( keys[2], args[2] );

                return v;
            }
            case 'docCas':
            {
                const cur = this.#read( keys[0] );
                let v = cur === null ? 0 : this.#version( cur );

                if( args[3] === '' )
                {
                    if( cur !== null ){return [ 0, v ];}
                }
                else if( cur === null || v !== Number( args[3] ) )
                {
                    return [ 0, v ];
                }

                v += 1;
                this.#strings.set( keys[0], { value : `{"version":${v},"doc":${args[0]}}` } );
                this.#sadd( keys[1], args[1] );
                this.#sadd( keys[2], args[2] );

                return [ 1, v ];
            }
            case 'docDelete':
            {
                const n = this.#del( keys[0] );

                this.#srem( keys[1], args[0] );

                if( !this.#sets.has( keys[1] ) ){this.#srem( keys[2], args[1] );}

                return n;
            }
            case 'docList':
            {
                const out: string[] = [];

                for( const id of [ ...( this.#sets.get( keys[0] ) ?? [] ) ] )
                {
                    const d = this.#read( args[0] + id );

                    if( d !== null ){out.push( d );}
                    else {this.#srem( keys[0], id );}
                }

                return out;
            }
            case 'docCount':
                return this.#sets.get( keys[0] )?.size ?? 0;
            case 'docClear':
            {
                const ids = [ ...( this.#sets.get( keys[0] ) ?? [] ) ];

                ids.forEach( ( id ) => {this.#del( args[0] + id );} );
                this.#sets.delete( keys[0] );
                this.#srem( keys[1], args[1] );

                return ids.length;
            }
            case 'docCollections':
                return [ ...( this.#sets.get( keys[0] ) ?? [] ) ];
            case 'cacheSet':
            {
                const px = args[2] === '' ? undefined : Number( args[2] );

                if( px !== undefined && ( !Number.isInteger( px ) || px <= 0 ) ){throw new Error( 'ERR invalid expire time in \'set\' command' );}

                this.#strings.set( keys[0], { value : args[0], expiresAt : px === undefined ? undefined : Date.now() + px } );
                this.#sadd( keys[1], args[1] );

                return 1;
            }
            case 'cacheDelete':
            {
                const n = this.#del( keys[0] );

                this.#srem( keys[1], args[0] );

                return n;
            }
            case 'cacheSize':
            {
                let n = 0;

                for( const id of [ ...( this.#sets.get( keys[0] ) ?? [] ) ] )
                {
                    if( this.#read( args[0] + id ) !== null ){n++;}
                    else {this.#srem( keys[0], id );}
                }

                return n;
            }
            case 'cacheClear':
            {
                const ids = [ ...( this.#sets.get( keys[0] ) ?? [] ) ];

                ids.forEach( ( id ) => {this.#del( args[0] + id );} );
                this.#sets.delete( keys[0] );

                return ids.length;
            }
        }
    }
}
