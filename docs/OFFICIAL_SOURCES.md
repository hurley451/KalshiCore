# Official Sources

KalshiCore keeps reviewed contract definitions in `contracts/`, but the
upstream source of truth is Kalshi's official documentation and specs.

`npm run refresh:sources` downloads:

- `https://docs.kalshi.com/openapi.yaml`
- `https://docs.kalshi.com/asyncapi.yaml`
- `https://docs.kalshi.com/llms.txt`

The command records source hashes, versions, operation counts, channel counts,
and documentation links under `sources/official/`. It does not generate SDK
code. Contract files should cite the relevant official `sourceId` and, for REST
endpoints, the OpenAPI `operationId`.

The command also updates `contracts/official-coverage.json`, which lists every
official REST operation and its KalshiCore review status. Operations begin as
`unreviewed`; they become `reviewed` only when a reviewed contract cites the
matching OpenAPI operation id.

`npm run validate` checks that cited source ids and operation ids exist in the
imported official source inventory and that reviewed coverage entries point to
real contracts. If the official source changes, refresh the inventory, compare
the generated diff, and update reviewed contracts and fixtures only for the
affected behavior.

The official source inventory is governance evidence. SDK conformance still
runs against the reviewed contracts and fixtures in this repository.
