# Local Tron Onboarding Demo Runbook

This captures the local setup used to demo KYC-less Tron onboarding: a user starts
with USDC on Arbitrum, sends one UniversalRouter transaction, and receives native
TRX on Tron without first funding a Tron account through a CEX.

## Components

- HTTP registry: local registry server at `http://localhost:3333`.
- TypeScript CLI relayer: `hyperlane relayer`, using the local registry and a
  `TronWallet` signer for Tron.
- Offchain lookup server / CCS: stores ICA reveal calls for the commitment-read
  ISM. For the demo, post calls before broadcasting the superswap tx.
- Universal router engine: builds and broadcasts the Arbitrum -> Tron superswap.

## Start The HTTP Registry

From the monorepo, run the HTTP registry server on port `3333` using the local
registry data you want the CLI and engine to share.

```bash
pnpm tsx typescript/infra/scripts/http-registry.ts
```

The engine defaults to `REGISTRY_URL=http://localhost:3333`.

## Start The CLI Relayer

Use both `HYP_KEY` and `HYP_KEY_TRON`. `HYP_KEY` is the EVM fallback key;
`HYP_KEY_TRON` is what makes the CLI create a `TronWallet` for Tron.

```bash
PK="$(op read 'op://Shared/UniversalRouter deployer 2026-04-21/privateKey')"

HYP_KEY="$PK" \
HYP_KEY_TRON="$PK" \
hyperlane relayer \
  --registry http://localhost:3333 \
  --chains arbitrum tron \
  --cache /tmp/hyperlane-cli-tron-relayer-cache.json \
  --yes
```

The relayer listens for Arbitrum dispatches and submits `mailbox.process` on
Tron.

## Broadcast A Demo Superswap

From `universal-router-engine`, post CCS calls before broadcasting so the relayer
can fetch reveal metadata immediately.

```bash
PRIVATE_KEY="$(op read 'op://Shared/UniversalRouter deployer 2026-04-21/privateKey')" \
AMOUNT_USDC=1 \
BROADCAST=true \
POST_CCS=true \
pnpm tsx scripts/broadcast-superswap.ts
```

Requirements:

- Arbitrum USDC balance for `AMOUNT_USDC`.
- Arbitrum ETH for router `msg.value` and gas.
- USDC -> Permit2 and Permit2 -> UniversalRouter approvals. If missing:

```bash
PRIVATE_KEY="$PK" AMOUNT_USDC=1 APPROVE=true pnpm tsx scripts/broadcast-superswap.ts
```

## CCS Payload Shape

Use the newer ICA-derived CCS API shape. It does not require
`commitmentDispatchTx`.

```json
{
  "calls": [{ "to": "0x...", "value": "0", "data": "0x..." }],
  "relayers": [],
  "salt": "0x<sender-as-bytes32>",
  "originDomain": 42161,
  "destinationDomain": 728126428,
  "owner": "0x<origin-universal-router>",
  "userSalt": "0x<sender-as-bytes32>"
}
```

For UniversalRouter commit/reveal, `owner` is the origin UniversalRouter address.
`userSalt` is the user/sender encoded as bytes32.

## Verify Delivery

For a single existing dispatch:

```bash
hyperlane status \
  --registry http://localhost:3333 \
  --origin arbitrum \
  --dispatchTx <arbitrum-tx-hash> \
  --id <message-id> \
  --relay \
  --yes
```

For read-only verification:

```bash
hyperlane status \
  --registry http://localhost:3333 \
  --origin arbitrum \
  --dispatchTx <arbitrum-tx-hash> \
  --id <message-id> \
  --yes
```

## Known Notes

- `hyperlane status --relay` needs a refreshed `HyperlaneCore` after lazy
  destination signer attachment. Draft PR:
  `https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/8713`.
- The Rust relayer currently cannot build Tron CCIP-read ISM metadata; the TS
  relayer path works because the CLI can instantiate `TronWallet`.
- If the relayer fails with Tron RPC `429`, use the HTTP registry on port `3333`
  with a better Tron RPC URL.
- If `msg.value` estimation fails, the Arbitrum account likely needs more ETH
  for IGP/native hook payment plus gas.

## Demo Evidence

Existing stuck reveal delivered on Tron:

```text
https://tronscan.org/#/transaction/e023e3fb8555cb197facd53b3ad739873e38457197901b1fcc554edfef23feef
```

Fresh demo broadcast:

```text
Arbitrum tx: 0x8078478ad9045eb644efaf8e819d81e664e8e53686aa127c67a6b9990df3e0b2
CCS post: 200 OK
```

CLI relayer-submitted Tron process txs:

```text
0xa0620e362040dd47c22b0d8c282a92425ae9b753e1d8b3c51f480b338bc7f0f9
0x6ba7fed4de7a9db8457ede170e0f50a61aacdefbb67587817d15b36d8bb64307
0x435febe5c9cd99085c71b3493e5ec2febf174f4fe5080b923a3640d7d20acdaf
```

Mailbox `delivered(messageId)` returned `true` for all three Arbitrum -> Tron
messages from that broadcast.
