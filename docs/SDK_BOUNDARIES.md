# SDK Boundaries

KalshiCore should make SDKs more correct without making them all look alike.

## Allowed Shared Outputs

KalshiCore may define or generate:

- Contract inventory indexes.
- Endpoint metadata and wire-level request expectations.
- JSON schemas for contract and fixture files.
- Golden request serialization and response parsing cases.
- WebSocket replay frames.
- Conformance report formats.
- Documentation tables derived from reviewed contract metadata.

These outputs are intentionally low-level. They describe the wire contract and
shared compatibility expectations.

## Out of Scope Without Separate Approval

KalshiCore should not generate or prescribe:

- Public client method names.
- Class, package, module, or namespace layout.
- Retry, logging, metrics, or dependency-injection abstractions.
- Async/runtime model choices.
- Package publishing configuration.
- Language-specific exception hierarchies.

Those choices belong in each SDK repository.

## Target Pinning

SDK repositories should pin the KalshiCore conformance input they validate
against. A target may pin a commit SHA, release tag, or future suite version.

KalshiCore changes can then be classified independently from SDK releases:

- Additive contract cases should not break targets that do not opt into the new
  area.
- Corrective contract changes should identify affected targets and required
  follow-up.
- Breaking conformance changes require an explicit version bump and migration
  note.

The first target should be KalshiSharp. Additional language targets should wait
until one real SDK can consume the basic conformance loop.
