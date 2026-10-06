import { SQLITE_DIALECT, SqlCacheStore, SqlDocStore } from './sql.js';
import type { SqlCacheStoreOptions, SqlClient, SqlDocStoreOptions } from './sql.js';

/** `IDocumentStore` on SQLite / LibSQL (`TEXT` JSON documents). See {@link SqlDocStore}. */
export class SqliteDocStore extends SqlDocStore
{
    constructor( client: SqlClient, options: SqlDocStoreOptions = {} )
    {
        super( client, SQLITE_DIALECT, options );
    }
}

/** `ICacheStore` on SQLite / LibSQL with application-clock TTL. See {@link SqlCacheStore}. */
export class SqliteCacheStore extends SqlCacheStore
{
    constructor( client: SqlClient, options: SqlCacheStoreOptions = {} )
    {
        super( client, SQLITE_DIALECT, options );
    }
}
