import { POSTGRES_DIALECT, SqlCacheStore, SqlDocStore } from './sql.js';
import type { SqlCacheStoreOptions, SqlClient, SqlDocStoreOptions } from './sql.js';

/** `IDocumentStore` on Postgres (`JSONB` documents, `bigint` versions). See {@link SqlDocStore}. */
export class PostgresDocStore extends SqlDocStore
{
    constructor( client: SqlClient, options: SqlDocStoreOptions = {} )
    {
        super( client, POSTGRES_DIALECT, options );
    }
}

/** `ICacheStore` on Postgres with application-clock TTL. See {@link SqlCacheStore}. */
export class PostgresCacheStore extends SqlCacheStore
{
    constructor( client: SqlClient, options: SqlCacheStoreOptions = {} )
    {
        super( client, POSTGRES_DIALECT, options );
    }
}
