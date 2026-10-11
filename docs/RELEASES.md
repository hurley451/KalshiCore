# Releases

KalshiCore releases are validated conformance suite snapshots. SDK targets pin a
release tag or commit SHA, then run their adapter against that immutable input.

## Versioning

Use `vMAJOR.MINOR.PATCH` tags.

- `MAJOR`: breaking contract, fixture, or target manifest changes.
- `MINOR`: additive endpoints, fields, fixtures, target manifests, or tooling
  that existing active targets can keep passing.
- `PATCH`: documentation, metadata, validation, or fixture clarifications that
  do not change adapter expectations.

Before marking a target `active`, replace `main` in its `kalshiCoreRef` with a
release tag or commit SHA.

## Release Workflow

Pushing a `v*.*.*` tag runs `.github/workflows/release.yml`. The workflow:

1. Installs dependencies with `npm ci`.
2. Runs `npm test`.
3. Runs `npm run validate`.
4. Creates a `kalshicore-<tag>.tar.gz` archive containing contracts, fixtures,
   targets, schemas, docs, and validation tooling.
5. Creates a GitHub release for the tag with the archive attached.

Release tags should only be pushed after the relevant SDK target adapters have
been run locally or in pull request CI against the intended commit.
