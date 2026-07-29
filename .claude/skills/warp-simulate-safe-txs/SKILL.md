---
name: warp-simulate-safe-txs
description: Simulate pending Safe (multisig) governance txs for a warp route by replaying the literal calldata onto anvil forks, self-relaying any ICA messages, then running warp check against the desired registry config. Use to verify that a not-yet-signed Safe batch produces the intended warp route config before signing.
---

# Warp Simulate Safe Txs

Verify that a pending Safe (Gnosis Safe / Heimdall) governance batch produces the
**desired warp route config** before anyone signs it. This replays the **exact
calldata** that will be signed (not a re-derived approximation) onto mainnet forks,
self-relays the resulting Interchain Account (ICA) messages, then runs `warp check`
against the target registry config.

This is the "fork → replay → check" loop. It catches issues like wrong owners,
wrong router addresses, or missing enrollments that would otherwise only surface
after the batch is signed and executed on-chain.

## When to use

- An engineer shares Heimdall / Safe links for a warp route extension or config
  change and asks "do these txs lead to the desired config in registry PR #XXXX?"
- Before signing any warp route governance batch.

## Input Parameters

| Parameter        | Required | Description                                                                                                         |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `safe_txs`       | Yes      | One or more `(chain, safeAddress, safeTxHash)` triples, or Safe/Heimdall URLs to derive them from.                  |
| `warp_route_ids` | Yes      | Warp route IDs the batch touches, e.g. `USDC/moonpay`, `USDT/moonpay`.                                              |
| `target_config`  | Yes      | The desired config to check against — usually a hyperlane-registry PR branch. Serve it via the local HTTP registry. |

Solana/Squads and other non-EVM legs cannot be EVM-forked; verify those separately.

## Prerequisites

- **Foundry `anvil`** must be on PATH and **version-matched to `cast`/`forge`**
  (mismatched anvil can mis-handle fork state). If `anvil` is missing:
  ```bash
  V=$(cast --version | sed -n 's/cast Version: //p' | head -1)   # e.g. 1.7.1
  cd /tmp && gh release download "v$V" --repo foundry-rs/foundry \
    --pattern "foundry_v${V}_linux_amd64.tar.gz" --clobber
  tar xzf "foundry_v${V}_linux_amd64.tar.gz" anvil && mkdir -p ~/.local/bin && mv anvil ~/.local/bin/
  export PATH="$HOME/.local/bin:$PATH"; anvil --version
  ```
- Monorepo root: `MONOREPO_ROOT=$(git rev-parse --show-toplevel)`. Prefix CLI commands with `cd $MONOREPO_ROOT &&`.
- A scratch dir, e.g. `WORK=/workspace/sandbox/_work/warp-sim` (or `$(mktemp -d)`).

## Instructions

### Step 1 — Fetch and decode each Safe batch

The Safe Transaction Service returns the batch as a single `MultiSend`
(`multiSend(bytes)`, selector `0x8d80ff0a`). Decode it into the inner txs that the
Safe executes (`to`, `value`, `data`). Note the **308 redirect** (`-L`) and the v2
endpoint.

```bash
SAFE_TX_HASH=0x....              # from the Safe/Heimdall link
curl -sL "https://safe-transaction-mainnet.safe.global/api/v2/multisig-transactions/${SAFE_TX_HASH}/" -o $WORK/aw.json
python3 - "$WORK" << 'EOF'
import json,sys
W=sys.argv[1]; d=json.load(open(f"{W}/aw.json"))
raw=d['data'][2:]
assert raw[:8]=='8d80ff0a', "expected MultiSend"
rest=raw[8:]; length=int(rest[64:128],16); packed=rest[128:128+length*2]
b=bytes.fromhex(packed); i=0; out=[]
while i<len(b):
    op=b[i]; i+=1; to='0x'+b[i:i+20].hex(); i+=20
    val=int.from_bytes(b[i:i+32],'big'); i+=32
    dl=int.from_bytes(b[i:i+32],'big'); i+=32
    out.append({'to':to,'value':str(val),'data':'0x'+b[i:i+dl].hex()}); i+=dl
json.dump(out, open(f"{W}/inner_txs.json","w"))
print(f"safe={d['safe']}  innerTxs={len(out)}")
EOF
```

The executing **safe address** is the `defaultSender` you impersonate. The inner
txs split into:

- **Direct calls** on the local (executing-chain) routers: `enrollRemoteRouters`
  (`0xe9198bf9`), `enrollCrossCollateralRouters` (`0x081954bc`), `setDestinationGas`
  (`0xb1bd6436`), `setFeeRecipient` (`0xe74b981b`).
- **ICA fan-out** to remote chains: `callRemoteWithOverrides` (`0xeab4eaa4`) on the
  origin InterchainAccountRouter. Each carries inner enroll calls destined for a
  remote router — these only take effect after the dispatched message is **relayed**.

### Step 2 — Replay on the executing chain and read router state (fast path)

This is the high-signal check and needs no relay. Fork the executing chain,
impersonate the safe, replay every inner tx, and read the resulting on-chain
enrollments. Compare against the `connections` in the target registry config.

```bash
export PATH="$HOME/.local/bin:$PATH"
RPC=$(grep -A12 'rpcUrls:' $MONOREPO_ROOT/../hyperlane-registry/chains/ethereum/metadata.yaml | sed -n 's/.*http: //p' | head -1)
FORK=http://127.0.0.1:8545; SAFE=0x....   # executing safe from Step 1
anvil --fork-url "$RPC" --port 8545 --silent > $WORK/anvil.log 2>&1 &
APID=$!; for k in $(seq 1 30); do cast block-number --rpc-url $FORK >/dev/null 2>&1 && break; sleep 2; done

cast rpc anvil_impersonateAccount $SAFE --rpc-url $FORK >/dev/null
cast rpc anvil_setBalance $SAFE 0xde0b6b3a7640000 --rpc-url $FORK >/dev/null
python3 - "$FORK" "$SAFE" "$WORK" << 'EOF'
import json,subprocess,sys
fork,safe,W=sys.argv[1:4]; ok=0; txs=json.load(open(f"{W}/inner_txs.json"))
for n,t in enumerate(txs,1):
    cmd=["cast","send","--from",safe,"--unlocked","--rpc-url",fork,t['to'],t['data']]
    if t['value']!="0": cmd+=["--value",t['value']]
    r=subprocess.run(cmd,capture_output=True,text=True)
    ok+= r.returncode==0
    if r.returncode: print(f"tx[{n}] FAIL {t['to']} :: {r.stderr.strip()[:160]}")
print(f"replayed {ok}/{len(txs)}")
EOF

# Read enrollments for each new domain on each local router. Getters:
#   remote (same-symbol):  routers(uint32)(bytes32)
#   cross-collateral:      getCrossCollateralRouters(uint32)(bytes32[])
ROUTER=0x....; DOMAIN=56   # e.g. bsc=56, katana=747474
cast call $ROUTER 'routers(uint32)(bytes32)' $DOMAIN --rpc-url $FORK
cast call $ROUTER 'getCrossCollateralRouters(uint32)(bytes32[])' $DOMAIN --rpc-url $FORK
kill $APID 2>/dev/null
```

Confirm each printed bytes32 (right-20-bytes) equals the router address listed in
the target config's `connections` for that chain/symbol. `routers()` must hold the
**same-symbol** counterpart; `getCrossCollateralRouters()` the **sibling** symbol
(e.g. USDC router's cross-collateral entry is the USDT router, and vice versa).

### Step 3 — Full route: fork all chains + replay via fork-config

`warp fork` forks every chain in the warp deploy config and can replay a Safe batch
natively. The fork command accepts a Safe-tx **FILE** (`SafeTxFileSchema`:
`{ version, chainId, transactions: [{ to, value, data }] }`) and auto-impersonates
the `defaultSender`. Build a `RawForkedChainConfigByChain` fork-config:

```yaml
# $WORK/fork-config.yaml
ethereum:
  transactions:
    - type: file
      path: ./safe-batch.json # SafeTxFileSchema shape (inner txs from Step 1)
      defaultSender: '0x3965AC...' # the executing safe
```

Serve the **target** (PR) registry so fork/check read the intended addresses (use
`/start-http-registry` pointed at the PR branch, or `--registry`), then:

```bash
cd $MONOREPO_ROOT && pnpm -C typescript/cli exec tsx cli.ts warp fork \
  --warpRouteId USDC/moonpay --registry http://localhost:3333 --fork-config $WORK/fork-config.yaml
```

### Step 4 — Self-relay the ICA messages across forks

Remote-chain enrollments (the `callRemoteWithOverrides` calls) only land after the
dispatched ICA message is delivered on the destination fork. For each ICA message,
self-relay it (see `/self-relay-hyperlane-message` and `typescript/cli/src/utils/relay.ts`’s
`runSelfRelay`), pointing the relayer at the fork registry.

> **ISM caveat (important):** on a mainnet fork the destination router's ISM is the
> real multisig, so self-relay cannot produce validator signatures. Before relaying,
> override the destination router's ISM to a permissive/Test ISM on the fork (call
> `setInterchainSecurityModule` via the impersonated owner, or set it to a
> TrustedRelayer/Test ISM), or use `warp apply --relay` whose JSON-RPC ICA submitter
> handles relay against fork ISMs. Without this, relay fails on `Mailbox: !verify`.

If full cross-fork relay isn't feasible in the environment, rely on Step 2 for the
executing chain and explicitly report that remote-chain enrollment was **not** relay-
verified (state it; don't claim a full pass).

### Step 5 — warp check against the desired config

```bash
cd $MONOREPO_ROOT && pnpm -C typescript/cli exec tsx cli.ts warp check \
  --warpRouteId USDC/moonpay --registry http://localhost:3333
# owner checks for ICA-owned routes:
cd $MONOREPO_ROOT && pnpm -C typescript/cli exec tsx cli.ts warp check \
  --warpRouteId USDC/moonpay --registry http://localhost:3333 --ica --origin ethereum
```

Expect **zero violations**. Cross-collateral routes (e.g. `CROSS/moonpay`) route
through `checkCrossCollateralWarpRoute`, which checks each constituent route.

### Step 6 — Cleanup (mandatory)

Kill every anvil fork and the http-registry before finishing — these are long-lived
processes and must not outlive the task.

```bash
pkill -f 'anvil --fork-url' 2>/dev/null
# stop the http-registry shell/task started in Step 3
```

### Step 7 — Report

- Per route/chain: PASS/FAIL with the concrete before→after router values vs the
  target config's `connections`.
- Which chains were directly replay-verified (Step 2) vs relay-verified (Step 4).
- Anything not covered (Solana/Squads, chains skipped, relay caveats).

## Gotchas (learned)

- `anvil` must be **version-matched** to `cast`/`forge`; install the exact release if missing.
- Safe Tx Service: use `-L` (308 redirect) and the `/api/v2/multisig-transactions/<safeTxHash>/` path.
- MultiSend selector `0x8d80ff0a`; packed layout per inner tx is `op(1) to(20) value(32) len(32) data(len)`.
- Router getters: same-symbol = `routers(uint32)`, cross-collateral = `getCrossCollateralRouters(uint32)` (NOT `crossCollateralRouters(uint32,bytes32)`, which is the bool `contains`).
- ICA `callRemoteWithOverrides` = `0xeab4eaa4`; enroll selectors `0xe9198bf9` / `0x081954bc`.
- The executing chain's direct calls are verifiable without relay; remote chains need cross-fork relay + an ISM override on the fork.

## Related skills

- `/warp-fork` — fork a warp route's chains.
- `/start-http-registry` — serve a local/PR registry for fork+check.
- `/self-relay-hyperlane-message` — deliver a dispatched message manually.
- `/warp-route-check` — standalone warp check.
