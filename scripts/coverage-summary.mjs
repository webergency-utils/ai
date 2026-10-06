import { readFileSync } from 'node:fs';

const s = JSON.parse( readFileSync( 'coverage/coverage-summary.json', 'utf8' ) ).total;
const row = ( k ) => `| ${ k } | ${ s[ k ].pct }% | ${ s[ k ].covered }/${ s[ k ].total } |`;

console.log( '### Coverage\n\n| Metric | % | Covered |\n| --- | --- | --- |' );

for( const k of [ 'statements', 'branches', 'functions', 'lines' ] )
{
    console.log( row( k ) );
}
