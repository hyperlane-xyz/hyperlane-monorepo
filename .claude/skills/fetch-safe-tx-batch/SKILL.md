---
name: fetch-safe-tx-batch
description: Fetch and decode a pending Safe (multisig) governance batch from the Safe Transaction Service into a chain-tagged transactions JSON file that `/warp-route-check` (or any downstream consumer with the same input shape) ingests. Safe-API integration only — no forks, no replay, no simulation.
---

# Fetch Safe Tx Batch — fetch + decode front end

Fetch a pending Safe / Heimdall multisig batch from the Safe Transaction Service, decode the MultiSend wrapper into inner transactions, tag each with the source `chainId`, and emit a single JSON file that `/warp-route-check` consumes. `/warp-route-check` then forks the touched chains, replays the batch under impersonated owners, self-relays any cross-chain ICA messages, and runs `hyperlane warp check` against the target registry config to verify the batch produces the desired state before anyone signs it.

This skill is intentionally narrow. The Safe Transaction Service integration (v2 endpoint URL, 308 redirect, MultiSend decode) is the only piece that's specific to Safe-style batches. Keeping it in its own skill leaves `/warp-route-check` generic — any chain-tagged transactions JSON works as input, regardless of whether it came from a Safe batch, a Heimdall queue, or a hand-rolled tx list.

## When to use

- An engineer shares Heimdall / Safe links for a warp route update and asks "do these txs lead to the desired config?"
- Before signing any warp route governance batch — the simulation downstream verifies the result against the target registry config.

## Input Parameters

| Parameter    | Required | Description                                                                                                                                                                       |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safe_txs`   | Yes      | One or more `(chainId, safeAddress, safeTxHash)` triples, or Safe / Heimdall URLs to derive them from. Multiple batches are concatenated into one chain-tagged transactions file. |
| `output_dir` | No       | Where to write the decoded files. Defaults to `~/.hyperlane/safe-batches/<timestamp>/`.                                                                                           |

Solana / Squads and other non-EVM legs cannot be EVM-forked — verify those separately. This skill handles EVM Safe batches only.

## Prerequisites

- `curl`, `python3`, `jq` on PATH. No `anvil` / `cast` / `forge` needed in this skill — those run in `/warp-route-check`.

## Instructions

### Step 1 — Fetch and decode each Safe batch

The Safe Transaction Service returns the batch as a single `MultiSend` (`multiSend(bytes)`, selector `0x8d80ff0a`). Decode it into the inner txs the Safe executes (`to`, `value`, `data`). Note the **308 redirect** (`-L`) and the **v2** endpoint.

For each `(chainId, safeAddress, safeTxHash)` triple in `safe_txs`:

```bash
SAFE_TX_HASH=0x....              # from the Safe / Heimdall link
CHAIN_ID=1                        # the executing chain
WORK=${output_dir:-~/.hyperlane/safe-batches/$(date +%s)}
mkdir -p "$WORK/decoded"

curl -sL "https://safe-transaction-mainnet.safe.global/api/v2/multisig-transactions/${SAFE_TX_HASH}/" \
  -o "$WORK/decoded/${CHAIN_ID}-${SAFE_TX_HASH}.json"

python3 - "$WORK" "$CHAIN_ID" "$SAFE_TX_HASH" << 'EOF'
import json, sys
W, chain_id, safe_tx = sys.argv[1], int(sys.argv[2]), sys.argv[3]
src = f"{W}/decoded/{chain_id}-{safe_tx}.json"
d = json.load(open(src))
raw = d['data'][2:]
assert raw[:8] == '8d80ff0a', "expected MultiSend"
rest = raw[8:]; length = int(rest[64:128], 16); packed = rest[128:128 + length * 2]
b = bytes.fromhex(packed); i = 0; out = []
while i < len(b):
    op = b[i]; i += 1; to = '0x' + b[i:i+20].hex(); i += 20
    val = int.from_bytes(b[i:i+32], 'big'); i += 32
    dl = int.from_bytes(b[i:i+32], 'big'); i += 32
    out.append({
        'chainId': chain_id,
        'safeAddress': d['safe'],
        'safeTxHash': safe_tx,
        'to': to,
        'value': str(val),
        'data': '0x' + b[i:i+dl].hex(),
    })
    i += dl
json.dump(out, open(f"{W}/decoded/{chain_id}-{safe_tx}.decoded.json", 'w'), indent=2)
print(f"chainId={chain_id} safe={d['safe']} innerTxs={len(out)}")
EOF
```

The executing **safe address** is each batch's `defaultSender` — `/warp-route-check` impersonates it on the fork. The inner txs typically split into:

- **Direct calls** on the local (executing-chain) routers: `enrollRemoteRouters` (`0xe9198bf9`), `enrollCrossCollateralRouters` (`0x081954bc`), `setDestinationGas` (`0xb1bd6436`), `setFeeRecipient` (`0xe74b981b`).
- **ICA fan-out** to remote chains: `callRemoteWithOverrides` (`0xeab4eaa4`) on the origin InterchainAccountRouter. Each carries inner enroll calls destined for a remote router — these only take effect after the dispatched message is **relayed** (handled in `/warp-route-check`).

### Step 2 — Combine decoded inner txs into one chain-tagged transactions file

Concatenate every `*.decoded.json` into a single array and write to `<output_dir>/transactions.json`:

```bash
jq -s 'add' "$WORK/decoded/"*.decoded.json > "$WORK/transactions.json"
echo "total inner txs: $(jq 'length' $WORK/transactions.json)"
echo "unique chainIds: $(jq -r '[.[].chainId] | unique | join(",")' $WORK/transactions.json)"
echo "unique safe senders: $(jq -r '[.[].safeAddress] | unique | join(",")' $WORK/transactions.json)"
```

The resulting `transactions.json` is the format `/warp-route-check` expects in Step 5 (it `jq`'s `.[].chainId` and `.[].to`).

### Step 3 — Hand off to `/warp-route-check`

Tell the user:

> Decoded `<N>` inner txs across `<M>` chains. Output:
>
> - `<output_dir>/transactions.json` — combined chain-tagged batch (the file to pass to `/warp-route-check`)
> - `<output_dir>/decoded/<chainId>-<safeTxHash>.decoded.json` — per-source-batch decoded copy (debugging / per-batch inspection)
>
> Run `/warp-route-check` next, passing `<output_dir>/transactions.json` as the `transactions-file` input. It will fork every touched chain, impersonate the safe(s) recorded in `safeAddress`, replay the inner txs, self-relay any cross-chain ICA messages, and verify the resulting state against the target registry config.

End the message there. This skill does NOT run forks, replay txs, or call `warp check` — those are `/warp-route-check`'s responsibilities.

## Gotchas

- **Safe Tx Service URL**: use `-L` (308 redirect) and the `/api/v2/multisig-transactions/<safeTxHash>/` path.
- **MultiSend layout**: selector `0x8d80ff0a`; packed per inner tx is `op(1) to(20) value(32) len(32) data(len)`.
- **Inner-call selectors** (sanity-check the decode):
  - `enrollRemoteRouters` — `0xe9198bf9`
  - `enrollCrossCollateralRouters` — `0x081954bc`
  - `setDestinationGas` — `0xb1bd6436`
  - `setFeeRecipient` — `0xe74b981b`
  - `callRemoteWithOverrides` (ICA fan-out) — `0xeab4eaa4`
- **Non-EVM batches** (Solana / Squads) — out of scope for this skill. They reach signers via a different propose path (`file` submitter, manual hand-off) and don't pass through Safe Transaction Service.

## Related skills

- `/warp-route-check` — the simulation engine this skill feeds into.
- `/warp-fork` — lower-level fork primitive used by `/warp-route-check`.
- `/start-http-registry` — serve the target / PR registry to fork+check.
- `/self-relay-hyperlane-message` — deliver a dispatched ICA message manually (used inside `/warp-route-check`).
