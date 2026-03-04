---
'@hyperlane-xyz/rebalancer-sim': minor
---

Scenario loading was extracted to a shared `ScenarioLoader` API with `SCENARIOS_DIR` env override support. A new `ResultsExporter` API was added for saving simulation results as JSON and HTML. Path traversal guards were added to both scenario loading and result export paths.
