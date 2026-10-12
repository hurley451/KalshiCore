# Complete Current Official Contract Bundle

`contracts/current-official.json` is a deterministic, source-linked contract
bundle, not a routing inventory. It embeds the complete parsed OpenAPI and
AsyncAPI documents, retaining all schema constraints, descriptions, examples,
security definitions, extensions, responses, and references. Original source
bytes are checked in as `sources/official/openapi.yaml` and `asyncapi.yaml`.
Source IDs, official URLs, dialects, and SHA-256 hashes accompany both documents.
No network request or clock participates in import generation.

## Artifact Format

- `sources.openapi.document` / `sources.asyncapi.document`: complete raw documents.
- `sources.*.references`: every reference location and its resolved target.
- `sources.*.schemas`: all component schemas and inline schema roots, including
  parameter, media/body, header, and message payload schemas. Nested constraints
  are retained and compiled through each root; examples are not schema roots.
- `rest[]`: operation identity and source JSON Pointer; effective path/operation
  parameter definitions (operation overrides path parameters); full request body;
  every success/error/default response, content type and encoding; effective
  security, servers, and deprecation. Schema references retain their original
  document scope, under the corresponding `sources.*.document`.
- `websocket.channels[]`: source-linked channel contracts, full typed message
  contracts, AsyncAPI direction, operation IDs, and connection command links.
  `receive` means client-to-server and `send` means server-to-client, from the
  documented server's perspective. This includes the root and control frames.
- `websocket.operations[]`: every declared AsyncAPI operation with its action,
  channel reference, and message references.
- `websocket.messages[]`: every component message, including typed commands
  without channel bindings; preserves schemas, headers, examples, and bindings.
- `websocket.sourceGaps[]`: explicit source inconsistencies. The supplied source
  declares `updateSubscriptionGetSnapshotCommand` without binding it to an
  AsyncAPI channel/operation. Its complete typed contract is included and compiled.
  A binding is not fabricated. Shared commands are connection contracts; channel
  applicability is described by the retained official channel/command prose.

`contracts/current-official-coverage.json` links every REST operation and WS
channel to an actual bundle contract using file plus JSON Pointer references.
`schemaAccounting: complete` is an import/completeness assertion, separate from
manual review. REST `disposition` preserves each complete entry in
`contracts/official-coverage.json`, including reviewed fills, contract ID, notes,
and future/irrelevant dispositions. Existing WS dispositions are preserved on
reimport. `effective` records present-in-source versus an explicit future
disposition; it does not invent effective dates or promote imported schemas to
reviewed. The original reviewed fills endpoint and its provenance remain intact.

The supplied source accounts for **118 REST operations, 15 WS channels, 41 WS
operations, 44 channel-message bindings, 44 component messages, 630 schema roots,
and 1,184 references**. There are 9 typed command variants. A component message
can have multiple channel bindings, so the two message counts are distinct.

## Commands And Gates

Run from the Core checkout:

```sh
node tools/full-contracts.js import /path/to/source-snapshots
node tools/validate.js
node tools/full-contracts.js
node --test tools/full-contracts.test.js
npm test
git diff --check
```

The importer first validates a staged candidate, compares snapshots to protect
concurrent edits, and replaces only the two bundle artifacts and two pinned YAML
files. Replacement/post-validation failures restore replaced outputs. Source
hash drift fails before any replacement. Refresh source ledgers explicitly when
adopting a changed official source, then reimport from the matching documents.
Manual dispositions cannot silently disappear during an import.

`npm test` runs the full-contract tests alongside the metadata, refresh and
release regressions. `npm run validate` requires both metadata and full-contract
validation. Existing CI, release and extracted-archive checks run these commands,
so neither full-contract gate is optional. Metadata refresh still needs a matching
full-contract import when the official source changes.

The full validator recomputes the bundle from pinned source bytes and compares
it exactly, verifies hashes/metadata/counts, validates artifact shapes with AJV
2020, resolves every reference, recompiles all schema roots, recomputes contract
and coverage links, and executes representative source-linked payload cases.
The structural tests reject removed operations, parameters, request bodies,
success/error responses, channels, messages, commands, schema roots, references,
counts, constraints, coverage links, and manual reviewed disposition changes.

## Schema Semantics And Proof Boundary

The raw source is unchanged. For AJV execution, a derived view translates
`nullable: true` (including official `$ref` and `allOf` wrappers) to a null
alternative. Locally declared enums/const still constrain null; non-null values
retain all original referenced/composed constraints. Required properties,
`allOf`, exclusive `oneOf`, numeric bounds, formats, enums, and const are covered
by positive and negative tests. There is no coercion, default insertion, or
property removal. AJV accepts official annotation/vendor keywords; extensions
and prose rules are retained, not silently converted into guessed assertions.

Some official REST responses declare only a status and description, with no
body schema. Their `bodyDeclaration` explicitly says `not-declared-by-source`;
this means no source body contract exists, not an empty invented JSON schema.
Future migration prose and WebSocket error-code definitions remain intact in
the documents, including `x-error-codes` and retired codes.

These gates prove complete structured source accounting and representative
payload validation. They do not prove any language SDK implements every contract,
prose-only business rule, authentication behavior, or live service behavior.
Parent/language delivery still needs adapter conformance and functional tests
against these contracts, and separate manual/live review where required.

## Perps Sources

Three additional bundles preserve independent document and reference namespaces:

| Bundle | Source coverage |
|--------|-----------------|
| `contracts/perps_openapi.json` | 51 REST operations |
| `contracts/perps_scm_openapi.json` | 27 clearing-member REST operations |
| `contracts/perps_asyncapi.json` | 8 WebSocket channels and 22 operations |

Each bundle has a source ledger, pinned YAML, operation inventory, coverage
manifest, and positive/negative fixtures. Security alternatives, server URLs,
and source inconsistencies are retained without combining authentication realms
or inventing missing contracts. Imported entries remain unreviewed.

```sh
npm run import:perps -- /path/to/perps-source-snapshots
npm run validate:perps
npm test
npm run validate
```

The import stages and validates all three sources before replacement. Failed
validation, staged mutation, replacement failure, or concurrent edits reject the
candidate and preserve prior artifacts and newer editor changes. Fixtures have
independent required identities, operation/schema bindings, and behavior checks;
preserving names or counts cannot substitute order cases for error, pagination,
composition, or WebSocket cases. Legitimate payload edits are preserved when
they still exercise the required behavior. These are representative contract
cases, not complete SDK implementation or live API approval.
