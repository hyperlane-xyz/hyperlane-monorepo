# Grafana Alert Rules

NOTE: these alert rule exports are **not** provisioned automatically. Grafana Cloud
remains the live source of truth; the JSON here is a manually-synced, version-controlled
reference (same convention as the dashboards one directory up). Update the file whenever
the corresponding rule changes in Grafana.

Each `*.json` is the export of a single Grafana managed alert rule.

## Rules

| File | Rule | Notes |
| ---- | ---- | ----- |
| `mainnet3-prepare-queue-anomalous-growth.json` | mainnet3 prepare queue anomalous growth with zero deliveries [critical] | Fires when a destination's relayer `prepare_queue` is >3x its own trailing 7d baseline AND >30 messages AND deliveries have gone to zero for 45m+. Catches per-destination delivery stalls (dead/hung lander task) that the level/`deriv`-based alerts miss, while staying quiet on chains with chronic upstream backlogs (flat vs baseline). |

## Syncing to Grafana

Rules are managed via the Grafana alerting API (or the UI). To re-import an exported rule,
`POST`/`PUT` the JSON to `/api/v1/provisioning/alert-rules` (adjust `uid`/`folderUID` as
needed), or paste the query/condition into a new rule in the UI.
