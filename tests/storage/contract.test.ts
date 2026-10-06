import { runDocumentStoreContract } from './contract/document.contract.js';
import { runVectorStoreContract } from './contract/vector.contract.js';
import { runCacheStoreContract } from './contract/cache.contract.js';
import { runFileStoreContract } from './contract/file.contract.js';
import { documentBackends, vectorBackends, cacheBackends, fileBackends } from './backends.js';

for( const b of documentBackends )
{
    runDocumentStoreContract( b.name, b.factory, b.options );
}

for( const b of vectorBackends )
{
    runVectorStoreContract( b.name, b.factory, b.options );
}

for( const b of cacheBackends )
{
    runCacheStoreContract( b.name, b.factory, b.options );
}

for( const b of fileBackends )
{
    runFileStoreContract( b.name, b.factory, b.options );
}
