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

Pushing an existing `vMAJOR.MINOR.PATCH` tag runs `.github/workflows/release.yml`.
Manual dispatch requires the same existing tag. The workflow checks out that
exact commit and requires the tag to match `package.json`'s version. It never
creates a missing tag from the default branch.

The workflow:

1. Installs dependencies with `npm ci`.
2. Runs `npm test`.
3. Runs `npm run validate`.
4. Creates a `kalshicore-<tag>.tar.gz` archive containing the license, suite
   commit/tag identity, contracts, fixtures,
   official source inventories, targets, schemas, docs, validation tooling and
   the release workflow checked by the tooling tests.
5. Extracts the archive into a clean consumer and repeats installation, tests
   and validation.
6. Creates a GitHub release for the existing tag with the archive and SHA-256
   checksum attached.

Release tags should only be pushed after the relevant SDK target adapters have
been run locally or in pull request CI against the intended commit.

## Consumer Verification

Download the archive and matching `.sha256` asset from the same GitHub release.
On Linux run `sha256sum -c <archive>.sha256`; on macOS use
`shasum -a 256 -c <archive>.sha256`. Extract into a new directory, then run:

```bash
npm ci
npm test
npm run validate
```

`suite-release.json` identifies the source commit and tag. Pass the extracted
directory as `KALSHICORE_ROOT` to an SDK adapter. Its conformance report is
separate evidence from suite structural validation.

Core is not an npm SDK. Its private `package.json` installs validation tooling;
SDK runtime packages are published independently by their target repositories.
