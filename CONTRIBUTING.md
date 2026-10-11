# Contributing

KalshiCore accepts focused changes to shared contracts, fixtures, target
manifests, conformance tooling, and governance documentation. Keep changes small
enough to review against evidence.

## Contribution Principles

- Preserve the boundary between KalshiCore and SDK repositories.
- Prefer source-linked contract changes over prose-only assertions.
- Add fixtures when they clarify request, response, error, or compatibility
  behavior.
- Keep target support explicit; do not imply coverage that is not validated.
- Report upstream gaps when shared truth is missing or ambiguous.

## Working Areas

- Documentation changes belong in `README.md`, `CONTRIBUTING.md`, or `docs/`.
- Contract definitions belong in `contracts/`.
- Shared examples and conformance cases belong in `fixtures/`.
- SDK target manifests belong in `targets/`.
- Shared validation and conformance utilities belong in `tools/`.

SDK-specific implementation changes belong in the SDK repository, not in
KalshiCore.

## Contract Changes

Before changing shared contract material:

1. Identify the affected endpoint, field, behavior, or compatibility rule.
2. Gather official documentation, OpenAPI material, reviewed API observation, or
   target gap evidence.
3. Add or update fixtures that demonstrate the behavior when practical.
4. Update target manifests if support status changes.
5. Run the relevant validation checks and include the result in the change.

If evidence is incomplete, file an upstream gap instead of encoding an
assumption.

## Target Changes

Target manifests should describe what a target validates today. Partial support
is acceptable when exclusions are explicit and actionable.

New targets should begin with offline fixture checks before adding live or
credentialed validation. Live checks should be optional and clearly separated
from deterministic conformance checks.

## Review Expectations

Pull requests should describe:

- The contract or target area changed.
- The evidence used.
- Fixtures or checks added or updated.
- Validation commands run.
- Remaining gaps or target exclusions.

Do not claim validation that has not been run.
