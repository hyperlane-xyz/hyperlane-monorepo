# zeroShadow Hermod Integration Notes

Source: `https://mimir.zeroshadow.io/docs/hermod.pdf`, read on 2026-04-28.

## Goal

Use the zeroShadow Hermod agent as the address-screening backend for Hyperlane's existing Predicate-gated warp route flow.

The recommended boundary is offchain:

1. Hermod runs as a private sidecar/service.
2. A Hyperlane-controlled attestation service checks Hermod before issuing a Predicate-compatible attestation.
3. Existing `PredicateRouterWrapper` / `PredicateCrossCollateralRouterWrapper` contracts enforce the signed attestation onchain.

Do not call Hermod from Solidity. Hermod is an HTTP service with private registry credentials, account secrets, and HMAC keys.

## Hermod Runtime

Inputs from zeroShadow:

- GHCR username and token for `ghcr.io/zeroshadowhq/hermod`.
- `CUSTOMER_ID`.
- HMAC key for signing queried addresses.

Container:

```bash
docker login ghcr.io
docker run \
  -p 3000:3000 \
  -e CUSTOMER_ID="$ZEROSHADOW_CUSTOMER_ID" \
  -e API_KEY="$HERMOD_API_KEY" \
  ghcr.io/zeroshadowhq/hermod:latest
```

Version tags follow semver-style Docker tags such as `1`, `1.4`, and `latest`. Pin a concrete tag for production after initial testing.

Environment variables:

| Name | Required | Use |
| --- | --- | --- |
| `CUSTOMER_ID` | yes | zeroShadow account ID. |
| `API_KEY` | no | Enables bearer/basic auth on Hermod endpoints. Use in shared environments. |
| `PORT` | no | Internal HTTP port. Default `3000`. |
| `SKIP_METRICS` | no | Disables `/metrics` and its Prometheus process when set. |

Operational endpoints:

- `GET /up.json`: readiness/health. Treat non-200 as not ready.
- `GET /metrics`: Prometheus metrics, introduced in Hermod v1.2.
- `GET /playground`: manual test UI, introduced in Hermod v1.3.

## Address Screening Semantics

Hermod does not take raw addresses on the primary read endpoint. Sign each raw address with the zeroShadow-provided HMAC key:

```ts
import { createHmac } from 'node:crypto';

export function hermodAddressSignature(hmacKey: string, address: string): string {
  return createHmac('sha256', hmacKey).update(address).digest('hex');
}
```

Then call:

```bash
curl -i \
  -H "authorization: Bearer $HERMOD_API_KEY" \
  "http://hermod:3000/addresses/$HMAC_SHA256_ADDRESS_SIGNATURE"
```

Interpret status codes as the source of truth:

| Status | Meaning | Integration action |
| --- | --- | --- |
| `200` | Hit: known threat. | Deny attestation / mark transfer non-compliant. |
| `404` | Miss: no threat. | Continue policy evaluation. |
| Other / timeout | Hermod unavailable or unexpected. | Fail closed unless product/security explicitly accepts fail-open. |

`POST /addresses` can be used only for local HMAC validation. It accepts `hmac_key` and raw `address`, then redirects to `GET /addresses/<signature>`. Do not use it in production request paths because it sends the HMAC key to the service per request.

Hermod auth:

- Bearer: `authorization: Bearer <api-key>`.
- Basic: `-u "x:<api-key>"`; the API key may be username or password.

## Hyperlane Touchpoints

Existing support:

- Onchain gating: `solidity/contracts/token/extensions/PredicateRouterWrapper.sol`.
- Cross-collateral gating: `solidity/contracts/token/extensions/PredicateCrossCollateralRouterWrapper.sol`.
- Wrapper deployment: `typescript/sdk/src/predicate/PredicateDeployer.ts`.
- CLI attestation fetch: `typescript/cli/src/send/transfer.ts`.
- Predicate API client shape: `typescript/sdk/src/predicate/PredicateApiClient.ts`.

Implementation path:

1. Deploy or identify Predicate registry/policy for the target route.
2. Configure the warp route token with `predicateWrapper`:

```yaml
predicateWrapper:
  predicateRegistry: "0x..."
  policyId: "..."
  owner: "0x..."
```

3. Deploy/apply the route so the router hook becomes an aggregation including the Predicate wrapper and the existing hook.
4. Add a small Hermod client in the attestation service, not in the Solidity contracts:
   - Normalize every address exactly once before HMAC signing.
   - Query sender and recipient addresses at minimum.
   - Consider route-specific policy for token owner, beneficiary, or extra calldata-derived addresses.
   - Deny on `200`.
   - Allow only on `404` after any other policy checks pass.
   - Fail closed on network, auth, JSON, or 5xx errors.
5. If reusing `PredicateApiClient`, keep its response contract unchanged:

```ts
interface PredicateAttestationResponse {
  policy_id: string;
  policy_name: string;
  verification_hash: string;
  is_compliant: boolean;
  attestation: {
    uuid: string;
    expiration: number;
    attester: string;
    signature: string;
  };
}
```

Hermod should be an internal dependency behind the service that returns that response, not a replacement for the Predicate-compatible response.

## Address Normalization

Define normalization before rollout. This is security-sensitive because Hermod signs bytes of the exact address string.

Recommended defaults:

- EVM: checksum or lowercase `0x` hex, choose one and test it against zeroShadow.
- SVM: canonical base58 pubkey string.
- Cosmos: canonical bech32 account string for the active chain prefix.
- Radix/Starknet/Aleo/Tron: use chain-native canonical account strings already emitted by wallet/provider adapters.

Add tests for equivalent user input formats where the UI accepts more than one representation.

## Tests

Hermod provides these hit fixtures; sign them with the real HMAC key before calling `GET /addresses/<signature>`:

```text
bc1000000000000000000000000000000000000000
0x0000000000000000000000000000000000000000
11111111111111111111111111111111111111111111
```

Minimum test matrix:

- HMAC vector from Hermod docs: address `1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa`, key `key`, expected signature `fc1c0060a3158f2b690ed2e5faa5a6a324276a2c162505e91a14b7baf1419e05`.
- `200` response denies attestation.
- `404` response allows the flow to continue.
- `401`/`403`/`500`/timeout fails closed.
- API key is sent on redirected test calls if `POST /addresses` is used locally.
- CLI `hyperlane warp send --predicate-api-key --predicate-api-url ...` still obtains an attestation and routes through the Predicate wrapper.

Relevant repo tests to extend:

- `typescript/sdk/src/predicate/PredicateApiClient.test.ts`
- `typescript/cli/src/tests/ethereum/warp/warp-send-predicate.e2e-test.ts`
- Any new attestation-service package tests if the Hermod integration lives outside this monorepo.

## Rollout Checklist

- [ ] Receive zeroShadow GHCR credentials, `CUSTOMER_ID`, and HMAC key.
- [ ] Store `HERMOD_API_KEY`, `ZEROSHADOW_CUSTOMER_ID`, and `ZEROSHADOW_HMAC_KEY` in the target secret manager.
- [ ] Deploy Hermod with a pinned image tag.
- [ ] Add health checks against `/up.json`.
- [ ] Scrape `/metrics`, unless `SKIP_METRICS` is intentionally enabled.
- [ ] Implement Hermod client in the attestation service.
- [ ] Confirm address normalization with zeroShadow hit/miss fixtures.
- [ ] Configure target warp route with `predicateWrapper`.
- [ ] Run predicate deploy/apply flow.
- [ ] Run blocked-address and allowed-address send tests.
- [ ] Document fail-closed operational behavior for support/oncall.

## Open Decisions

- Which service owns Predicate-compatible attestation issuance for this integration.
- Exact production image tag instead of `latest`.
- Chain-by-chain address normalization contract.
- Whether to screen sender only, recipient only, or both for each product surface.
- Whether Hermod outage blocks all gated transfers or can be overridden by an emergency operator path.
