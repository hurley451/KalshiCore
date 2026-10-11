# KalshiCore

[![Validate](https://github.com/hurley451/KalshiCore/actions/workflows/validate.yml/badge.svg?branch=main)](https://github.com/hurley451/KalshiCore/actions/workflows/validate.yml)
[![GitHub stars](https://img.shields.io/github/stars/hurley451/KalshiCore.svg?style=social)](https://github.com/hurley451/KalshiCore/stargazers)

KalshiCore is the parent contract and conformance repository for Kalshi SDK
implementations. It owns shared API contracts, fixtures, target manifests, and
conformance expectations that language-specific SDK repositories validate
against.

KalshiSharp is the first and reference target. It remains an idiomatic .NET SDK:
KalshiCore defines the shared truth it must satisfy, while KalshiSharp owns its
public API shape, runtime behavior, packaging, and .NET-specific ergonomics.
KalshiTS and kalshi-rs follow the same model for their language ecosystems rather
than inheriting a generated public client design from this repository.

This project is independent of Kalshi and is not an official Kalshi SDK.

## SDK Family

| Repository | Runtime distribution | Responsibility |
|------------|----------------------|----------------|
| [KalshiSharp](https://github.com/hurley451/KalshiSharp) | NuGet `KalshiSharp` | C# / .NET SDK |
| [KalshiTS](https://github.com/hurley451/KalshiTS) | npm `@hurley451/kalshi-ts` | TypeScript / JavaScript SDK |
| [kalshi-rs](https://github.com/hurley451/kalshi-rs) | Cargo `kalshi-client` | Rust SDK |
| KalshiCore | Versioned GitHub suite archive | Shared contracts and conformance inputs |

Package names identify intended distributions, not proof of publication. Check
each target's README and registry for its current release status.

## Quick Start

Use Node.js 24 and npm for the shared tooling. A local checkout is sufficient:

```bash
git clone https://github.com/hurley451/KalshiCore.git
cd KalshiCore
npm ci
npm test
npm run validate
```

Validation checks structure, inventories, fixture payloads, source identity,
embedded response schemas and target references. It does not execute SDKs or
call the exchange. SDK adapters are separate executable checks.

For reproducibility, check out an immutable Core commit or published suite tag
before recording a target's release evidence. See [suite releases](docs/RELEASES.md)
for archive checksums, source identity and installation verification. Core's
private npm project installs tooling; it is not a runtime client package.

## Current Coverage

The recorded official OpenAPI 3.34.0 snapshot contains 118 REST operations. One
endpoint contract, portfolio fills, has reviewed response material. The other
117 operations remain explicitly unreviewed in `contracts/official-coverage.json`.
The operation inventory includes IDs, methods, paths, summaries, tags and
repeated-array query encoding, not complete parameter/body/response schemas.

Four offline fixtures cover signing canonicalization, fills query serialization,
fills response parsing and order-book message replay. These are focused cases,
not full cryptographic, live API, all-endpoint or WebSocket connection approval.
The individual SDK adapters own the strength of their execution assertions.

Target manifests currently use draft/example status. A target must demonstrate
its adapter, pin an immutable Core ref and document exclusions before activation.
See [target onboarding](docs/SDK_TARGETS.md).

## Run a Target Adapter

From a KalshiTS checkout after `npm ci` and `npm run build`:

```bash
npm run conformance -- --kalshicore-root /path/to/KalshiCore --report artifacts/kalshicore-conformance/report.json
```

Rust and .NET commands are recorded in their respective `targets/` manifests.
Keep adapter dependencies in the SDK checkout, not in this repository. Inspect
the report's executed fixture IDs and failures; a suite validator result alone
does not prove target compliance.

## Official Sources and Refresh

Source metadata records URLs, retrieval timestamps, content hashes and counts:

- [Official REST OpenAPI](https://docs.kalshi.com/openapi.yaml)
- [Official WebSocket AsyncAPI](https://docs.kalshi.com/asyncapi.yaml)
- [Official documentation index](https://docs.kalshi.com/llms.txt)

Refresh in an isolated checkout, then review the complete diff:

```bash
npm run refresh:sources
npm test
npm run validate
git diff -- contracts/official-coverage.json sources/official
```

Refresh downloads and validates a candidate before replacing snapshot files.
Review decisions are preserved; changed or removed reviewed identities require
explicit disposition. Download, parse or validation errors leave the prior
snapshot intact. A successful refresh does not review new endpoint schemas or
authorize changed SDK behavior.

## Reporting Gaps

Use a [contract gap](https://github.com/hurley451/KalshiCore/issues/new?template=contract-gap.yml)
for missing shared expectations, fixtures or official-contract discrepancies.
Include official links, the affected target, a reproducible case and expected
behavior. Use the SDK repository for language-specific implementation defects.

Daily SDK drift workflows can report parent gaps when their repository credential
is configured. Schedule configuration alone does not prove issue filing works.
Do not include API keys, private keys, account identifiers or sensitive live
responses in public issue bodies.

## Repository Model

- `contracts/` defines reviewed API contract material and schema metadata.
- `fixtures/` contains request, response, and behavior examples used by
  conformance checks.
- `sources/` records imported official Kalshi source metadata and operation
  inventories.
- `targets/` records SDK target manifests that describe how each implementation
  is validated.
- `tools/` contains shared validation and conformance tooling.
- `docs/` explains architecture, target onboarding, and contract governance.

This repository should stay focused on shared contract truth and compatibility
checks. SDK repositories own language-specific abstractions, dependencies,
release cadence, and user-facing documentation.

## Boundaries and Deferred Work

SDKs own public APIs, authentication implementation, retries, runtime choices,
packaging and release cadence. Core does not prescribe generated class layouts
or uniform language ergonomics.

Broader endpoint schemas, additional edge/error fixtures, credentialed integration
evidence and deeper WebSocket replay remain future work. New language targets
should first demonstrate one useful offline adapter before expanding coverage.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [SDK Targets](docs/SDK_TARGETS.md)
- [Language Target Roadmap](docs/LANGUAGE_TARGET_ROADMAP.md)
- [Contract Change Policy](docs/CONTRACT_CHANGE_POLICY.md)
- [Official Sources](docs/OFFICIAL_SOURCES.md)
- [SDK Boundaries](docs/SDK_BOUNDARIES.md)
- [Releases](docs/RELEASES.md)
- [Contributing](CONTRIBUTING.md)

## License

KalshiCore is licensed under the [MIT License](LICENSE).
