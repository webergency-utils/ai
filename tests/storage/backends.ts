import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';
import
{
    MemoryDocStore,
    MemoryVectorStore,
    MemoryCacheStore,
    MemoryFileStore,
    LocalDiskFileStore
} from '../../src/storage/index.js';
import type { IDocumentStore, IVectorStore, ICacheStore, IFileStore } from '../../src/storage/index.js';
import type { CacheContractOptions } from './contract/cache.contract.js';
import type { FileContractOptions } from './contract/file.contract.js';
import type { ContractFactory, ContractOptions } from './contract/shared.js';
import { VECTOR_CONTRACT_DIMENSIONS } from './contract/vector.contract.js';

export interface BackendEntry<T, O extends ContractOptions = ContractOptions>
{
    name     : string
    factory  : ContractFactory<T>
    options? : O
}

export const documentBackends: Array<BackendEntry<IDocumentStore>> =
[
    { name : 'MemoryDocStore', factory : () => {return { store : new MemoryDocStore() };} }
];

export const vectorBackends: Array<BackendEntry<IVectorStore>> =
[
    {
        name    : 'MemoryVectorStore',
        factory : () => {return { store : new MemoryVectorStore( { dimensions : VECTOR_CONTRACT_DIMENSIONS } ) };}
    }
];

export const cacheBackends: Array<BackendEntry<ICacheStore, CacheContractOptions>> =
[
    {
        name    : 'MemoryCacheStore',
        options : { lenientValues : true },
        factory : () =>
        {
            vi.useFakeTimers( { toFake : [ 'Date' ] } );

            return {
                store       : new MemoryCacheStore(),
                advanceTime : async ( ms ) => {vi.setSystemTime( Date.now() + ms );},
                dispose     : async () => {vi.useRealTimers();}
            };
        }
    }
];

export const fileBackends: Array<BackendEntry<IFileStore, FileContractOptions>> =
[
    { name : 'MemoryFileStore', factory : () => {return { store : new MemoryFileStore() };} },
    {
        name    : 'LocalDiskFileStore',
        options : { enforcesPaths : true },
        factory : async () =>
        {
            const dir = await fsPromises.mkdtemp( path.join( os.tmpdir(), 'ai-contract-disk-' ) );

            return {
                store   : new LocalDiskFileStore( dir ),
                dispose : async () => {await fsPromises.rm( dir, { recursive : true, force : true } );}
            };
        }
    }
];
