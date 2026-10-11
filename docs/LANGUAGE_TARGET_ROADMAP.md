# Language Target Roadmap

KalshiCore should add SDK targets in the order that maximizes user reach while
keeping each implementation idiomatic.

| Priority | Target | Proposed repository | Why first | Main constraints |
| --- | --- | --- | --- | --- |
| 1 | TypeScript / JavaScript | `hurley451/KalshiTS` | Largest automation and trading-bot audience, first-class npm distribution, strong fit for generated fixture runners. | Node/browser boundaries, ESM/CJS packaging, crypto support differences, abort/retry ergonomics. |
| 2 | Python | `hurley451/KalshiPy` | Heavy overlap with quant, research, notebooks, and scripting workflows. | Sync vs async API shape, optional dependencies, pydantic/dataclass choice, key loading ergonomics. |
| 3 | Go | `hurley451/KalshiGo` | Strong fit for low-latency services, simple static binaries, and clean conformance runners. | Context propagation, rate-limit policy surface, decimal/fixed-point representation, module naming. |
| 4 | Rust | `hurley451/kalshi-rs` | Best fit for strongly typed trading infrastructure and robust WebSocket clients. | Higher implementation cost, async runtime choice, serde compatibility, crypto/key parsing friction. |
| 5 | Java | `hurley451/kalshi-java` | Useful for enterprise and JVM shops after the highest-demand scripting/service targets exist. | Build/publishing ceremony, Java version floor, HTTP client choice, verbose model maintenance. |

## Target Entry Criteria

A language SDK should become a KalshiCore target only after it has:

- A repository with clear package ownership and license.
- An offline conformance adapter that reads KalshiCore fixtures.
- CI that runs the adapter on pull requests, pushes to `main`, and a daily
  schedule.
- A scheduled drift path that files or updates KalshiCore `contract-gap` issues.
- A target manifest with explicit support, exclusions, adapter command, and
  report path.

## First Implementation Slice

`hurley451/KalshiTS` now starts with the same narrow fixture suite used by
KalshiSharp:

- API key signing canonical path behavior.
- `GET /portfolio/fills` query serialization.
- `GET /portfolio/fills` response shape.
- WebSocket orderbook replay deserialization.

Python should follow after TypeScript reaches the same offline conformance
baseline.
