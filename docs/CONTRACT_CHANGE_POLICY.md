# Contract Change Policy

KalshiCore contract changes affect every SDK target. Changes should be small,
source-backed, fixture-backed where possible, and explicit about compatibility.

## Change Types

- Additive changes add new endpoints, fields, enum values, fixtures, or target
  coverage without changing existing expectations.
- Corrective changes repair contract material that was incomplete, inaccurate,
  or ambiguous.
- Breaking changes remove or change existing expectations in a way that can
  require SDK updates.

Breaking changes require clear justification, migration guidance, and target
impact review.

## Required Evidence

Contract changes should include at least one of:

- Official Kalshi documentation or OpenAPI evidence.
- Reviewed live API observation captured as a fixture.
- A target gap report with reproduction steps and observed impact.

Prose-only claims should not become contract truth. If evidence is not yet
available, open or update an upstream gap instead.

## Review Flow

1. Identify the affected contract area and SDK targets.
2. Add or update contract material.
3. Add or update fixtures that prove the behavior.
4. Update target manifests when support status or exclusions change.
5. Run the relevant validation or conformance checks.
6. Record unresolved gaps and target impacts in the change.

The smallest reviewable change is preferred. Large endpoint families should be
split when they can be validated independently.

## Compatibility Expectations

KalshiCore should preserve existing target compatibility unless a breaking
change is intentional and documented. When behavior is uncertain, mark it as a
gap rather than forcing SDKs to conform to an unverified interpretation.

Targets may temporarily exclude unsupported or unresolved areas in their
manifests. Exclusions should be specific and tied to an issue, gap report, or
follow-up plan.

## Upstream Gaps

An upstream gap is a missing or disputed piece of shared contract truth. Gaps
should be reported when:

- Official material is absent or internally inconsistent.
- Live API behavior conflicts with existing contract material.
- A target cannot implement or verify behavior without guessing.
- A fixture exposes behavior that should be generalized into the contract.

Gap reports should remain open until the contract, fixture, and target impact
are resolved.
