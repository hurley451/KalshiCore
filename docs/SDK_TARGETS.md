# SDK Targets

An SDK target is a language-specific implementation that validates against
KalshiCore contracts and fixtures. Targets are described by manifests in
`targets/`.

## Target Manifest Concept

A target manifest should identify:

- The SDK repository and primary language.
- The target status, such as reference, active, experimental, or planned.
- The conformance adapter entry point.
- Supported contract areas and known exclusions.
- Required environment variables or credentials for live checks, if any.
- The command used to run offline fixture checks.
- The command used to run optional live or integration checks.

The manifest is a contract between KalshiCore and the SDK repository. It should
be stable enough for automation while remaining small enough to maintain by
hand.

## Reference Target

KalshiSharp is the first and reference target. It should be used to validate
that KalshiCore contracts, fixtures, and conformance tooling are useful in a
real SDK repository.

Reference target status does not require other SDKs to mirror KalshiSharp's API
surface. Future SDKs should expose idiomatic APIs for their ecosystems while
meeting the shared contract expectations in KalshiCore.

## Target Onboarding

To add a target:

1. Add or update the target manifest.
2. Provide a conformance adapter in the SDK repository or an agreed integration
   location.
3. Mark supported and unsupported contract areas explicitly.
4. Run offline fixture checks and include the result in the change.
5. File upstream gaps for contract behavior that cannot be verified from the
   current shared material.

Targets should start narrow. A partial target with clear exclusions is better
than broad implied coverage.

## Upstream Gap Reporting

When a target exposes missing, ambiguous, or conflicting contract behavior,
report the gap upstream in KalshiCore before changing shared fixtures or
contract definitions. A gap report should include:

- The affected endpoint or behavior.
- The source of the discrepancy.
- The SDK impact.
- Fixture evidence or a minimal reproduction when available.
- The proposed contract change, if one is clear.

Gap reports preserve the boundary between SDK implementation work and shared
contract governance.
