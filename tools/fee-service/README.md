# Fee Service

Offchain fee recommendation service for:
- IGP config recommendations
- warp fee recommendations
- versioned recommendation snapshots
- an Infra-facing HTTP API

## Run

```bash
cd tools/fee-service
python3 -m pip install -r requirements.txt
python3 main.py serve
```

## Main Infra Endpoints

- `GET /api/infra/status`
- `GET /api/infra/snapshots`
- `GET /api/infra/snapshots/latest`
- `GET /api/infra/snapshots/<snapshot_id>`
- `GET /api/infra/snapshots/<ref>/igp-config`
- `GET /api/infra/snapshots/<ref>/warp-config`
- `GET /api/infra/snapshots/<ref>/config-bundle`
- `POST /api/infra/refresh`
- `GET /api/infra/refresh/<job_id>`

`<ref>` may be `latest` or an explicit `snapshot_id`.

## Intended Consumption

Infra should consume `api/infra/*` rather than raw scan artifacts.

Default:
- fetch `GET /api/infra/snapshots/latest/config-bundle`

Pinned:
1. fetch `GET /api/infra/snapshots/latest`
2. capture `snapshot_id`
3. fetch by-id config endpoints

## Notes

- Periodic refresh currently runs in-process when the service is started with `python3 main.py serve`.
- Data and snapshots are written under `tools/fee-service/data`.
- The service is self-contained under `tools/fee-service` and does not modify the rest of the monorepo unless an operator explicitly uses the IGP proposal/submission flow.

## Validation

```bash
cd tools/fee-service
python3 -m unittest \
  tests/test_infra_snapshots.py \
  tests/test_api_infra_service.py \
  tests/test_api_igp_submit_status_codes.py \
  tests/test_igp_submission.py
```
