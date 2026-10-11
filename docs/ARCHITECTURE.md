# Architecture

KalshiCore is the shared contract and conformance layer for Kalshi SDK
implementations. It is not an SDK, code generator, package template, or
language abstraction layer.

## Responsibilities

KalshiCore owns:

- Reviewed contract definitions and compatibility policy.
- Shared fixtures for requests, responses, validation cases, and known edge
  behavior.
- Target manifests that describe how SDK repositories participate in
  conformance.
- Shared tooling that checks contracts and fixtures consistently across SDKs.
- Upstream gap tracking when SDK work uncovers missing or ambiguous contract
  material.

SDK repositories own:

- Idiomatic public APIs for their language.
- Runtime implementation, authentication flow, transport choices, and
  dependency management.
- Package metadata, examples, release notes, and language-specific
  documentation.
- Adapter code that maps local implementation details to KalshiCore
  conformance expectations.
- Evidence-backed reports when the shared contract is incomplete or incorrect.

## Parent and Target Flow

KalshiCore publishes shared expectations. SDK targets consume those
expectations through a target manifest and conformance adapter. The adapter
executes SDK behavior against shared fixtures and reports whether the SDK
matches the reviewed contract.

KalshiSharp is the first target and serves as the reference implementation for
the conformance workflow. Reference target status means KalshiSharp helps prove
that the framework is practical; it does not make .NET API design the required
shape for other SDKs.

## Contract Sources

Contract material should be tied to source evidence whenever possible:

- Official Kalshi documentation or OpenAPI material.
- Observed API behavior captured as reviewed fixtures.
- Existing SDK behavior accepted as compatibility-preserving only when it is
  clearly marked and backed by tests.

Claims that cannot be tied to source evidence should be tracked as gaps instead
of silently becoming shared truth.

Contract entries should carry a provenance status:

- `official-confirmed` for reviewed official Kalshi documentation or OpenAPI
  material.
- `observed-live-api` for reviewed live behavior captured as fixtures.
- `observed-sdk` for implementation behavior that needs upstream confirmation.
- `fixture-inferred` for behavior generalized from examples but not yet
  official.
- `pending-review` for material that should not gate SDK conformance yet.

## Conformance Boundary

Conformance checks should validate shared behavior such as endpoint shape,
request serialization, response parsing, error handling, and compatibility
rules. They should avoid prescribing language-specific method names, class
hierarchies, async models, logging frameworks, or package layout.

The goal is portable correctness, not uniform SDK design.
