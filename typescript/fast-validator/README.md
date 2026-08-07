# @hyperlane-xyz/fast-validator (prototype)

A **stateless, cross-chain** Hyperlane validator: instead of indexing every
origin chain, building its own merkle tree, and pushing signed checkpoints to
S3, this service runs an HTTP API that the relayer hits on-demand with
`(message, tx hash, merkle proof)`. The validator verifies the claim against
its configured RPC nodes and returns a signature compatible with the existing
`MessageIdMultisigIsm` / `MerkleRootMultisigIsm` contracts.

## Design

```
                                      ┌────────────────────────────┐
  Relayer  ──── POST /v1/sign ────►   │ fast-validator (stateless) │
                                      │                            │
                                      │  1. fetch tx receipt       │
                                      │  2. assert Dispatch event  │
                                      │     w/ messageId in tx     │
                                      │  3. branchRoot(leaf, proof,│
                                      │       index)==claimedRoot  │
                                      │  4. merkleTreeHook         │
                                      │     .latestCheckpoint()    │
                                      │     @ tx block matches     │
                                      │  5. sign EIP-191 digest    │
                                      └────────┬───────────────────┘
                                               │
                                               ▼
                  { validator, signature, checkpoint, message_id }
```

The signed digest matches `CheckpointLib.digest` in
`solidity/contracts/libs/CheckpointLib.sol`:

```
EIP191(
  keccak256(
    domainHash(originDomain, merkleTreeHook) || claimedRoot || leafIndex || messageId
  )
)
```

so a signature produced by the fast validator drops into the existing multisig
ISM verification path with **no on-chain changes**.

### Cross-chain

One process serves N origin chains. Each chain entry in the config provides
the mailbox, the MerkleTreeHook, the RPC URL(s), and a reorg period. The same
EVM signing key validates for every chain — the operator just runs the
announce script once per chain to register their endpoint on each chain's
`ValidatorAnnounce` contract.

### Storage location format

`ValidatorAnnounce.storageLocations[validator]` is a free-form string that the
relayer parses by prefix today (`s3://`, `file://`, `gs://`). For an
API-style validator we propose:

```
https+sign://validator.example.com/v1
```

The relayer would learn to detect the `https+sign://` prefix, strip it to
`https://`, and POST to `<base>/sign` for each message it wants signed. (The
relayer change is out of scope for this prototype — see "Relayer integration"
below.)

## Running

### Config

`config.yaml`:

```yaml
chains:
  ethereum:
    domain: 1
    mailbox: '0xc005dc82818d67AF737725bD4bf75435d065D239'
    merkleTreeHook: '0x48e6c30B97748d1e2e03bf3e9FbE3890ca5f8CCA'
    rpcUrls:
      - https://ethereum-rpc.example/v1/key
    reorgPeriod: 14
  arbitrum:
    domain: 42161
    mailbox: '0x979Ca5202784112f4738403dBec5D0F3B9daabB9'
    merkleTreeHook: '0x748040afB89B8FdBb992799808215419d36A0930'
    rpcUrls:
      - https://arb1.example/rpc
    reorgPeriod: 0
```

### Start the server

```bash
export VALIDATOR_KEY=0x...
pnpm --filter @hyperlane-xyz/fast-validator build
pnpm --filter @hyperlane-xyz/fast-validator start -- --config ./config.yaml --port 8080
```

or for hot-reload during development:

```bash
pnpm --filter @hyperlane-xyz/fast-validator start:dev -- --config ./config.yaml
```

### Endpoints

| Method | Path          | Body / Notes                                                                   |
| ------ | ------------- | ------------------------------------------------------------------------------ |
| GET    | `/health`     | liveness                                                                       |
| GET    | `/v1/address` | returns `{ address }` (the validator EVM address derived from `VALIDATOR_KEY`) |
| GET    | `/v1/chains`  | lists the chains this validator serves                                         |
| POST   | `/v1/sign`    | see below                                                                      |

`POST /v1/sign` request:

```json
{
  "origin": "ethereum",
  "txHash": "0x<32-byte dispatch tx hash>",
  "messageId": "0x<32-byte message id>",
  "leafIndex": 12345,
  "claimedRoot": "0x<32-byte root after the message was inserted>",
  "proof": ["0x..", "... 32 entries ..."]
}
```

response (200):

```json
{
  "validator": "0x...",
  "signature": "0x... (65 bytes)",
  "checkpoint": {
    "root": "0x...",
    "index": 12345,
    "mailbox_domain": 1,
    "merkle_tree_hook_address": "0x..."
  },
  "message_id": "0x..."
}
```

errors:

| Code | Meaning                                      |
| ---- | -------------------------------------------- |
| 400  | malformed request body                       |
| 422  | verification failed — see `error` + `detail` |
| 500  | internal error (network, RPC down, etc.)     |

### Announce

```bash
export VALIDATOR_KEY=0x...
pnpm --filter @hyperlane-xyz/fast-validator announce -- \
  --config ./config.yaml \
  --chain ethereum \
  --validator-announce 0x... \
  --storage-location https+sign://validator.example.com/v1 \
  --submit
```

Without `--submit` the script only prints the announcement signature so the
operator can broadcast separately (e.g. via a multisig).

## Verification details

1. **Dispatch in tx** — fetches the tx receipt and asserts the configured
   mailbox emitted both a `DispatchId(messageId)` with the claimed id and a
   matching `Dispatch(...)` whose `keccak256(message)` equals that id.
2. **Merkle proof** — reconstructs the root from the leaf + proof + index
   using `MerkleLib.branchRoot`'s algorithm; rejects on mismatch.
3. **On-chain anchor** — calls `MerkleTreeHook.latestCheckpoint()` at the
   dispatch tx's block (after `reorgPeriod` confirmations) and rejects unless
   it returns exactly `(claimedRoot, leafIndex)`. This is the trust anchor:
   without it a malicious relayer could fabricate any `(root, proof)` pair.
4. **Sign** — `EIP191(keccak256(domainHash || root || index || messageId))`
   using `BaseValidator.messageHash` from `@hyperlane-xyz/utils`.

## Limitations (prototype, in priority order)

- **Same-block dispatches** — `latestCheckpoint()` only returns the last
  insertion in a block, so requests where another message was dispatched in
  the same block (after this one) currently fail at step 3. A production
  version should use `eth_getLogs` to find the specific
  `InsertedIntoTree(messageId, index)` event and verify there.
- **Reorg handling** — the current code requires `head >= txBlock + reorgPeriod`
  but does not re-check the tx after the reorg window elapses on the same
  branch. Acceptable for L2s with deterministic finality, weaker on L1.
- **No persistent reorg-detection / `reorg.json`** — the existing validator
  posts a reorg flag if it ever observes a finalized branch differing from
  what it signed. The stateless model has no memory and so cannot detect this
  retroactively. The reorg period is the only defense.
- **EVM only** — the relayer-facing API is chain-agnostic, but the verifier
  currently only talks JSON-RPC to EVM mailboxes. Other VMs would require
  per-VM verification adapters.
- **No RPC failover for `eth_call`** — `getReceiptWithFailover` rotates across
  RPC URLs but the `merkleTreeHook` call always uses `providers[0]`.
- **No rate limit / auth** — the prototype exposes `POST /v1/sign` openly.
  Production deployments should require an API key or mTLS between the
  relayer and validator.

## Relayer integration (out of scope for this prototype)

To actually use the fast validator, the relayer needs two small changes:

1. **Storage-location parser** in
   `rust/main/hyperlane-base/src/settings/checkpoint_syncer.rs` should learn
   a new prefix (e.g. `https+sign://`) that constructs a new
   `CheckpointSyncer` impl which posts to the URL rather than reading from
   blob storage.
2. **`CheckpointSyncer` impl** that exposes a "fetch signature for this
   specific message" path and POSTs to `/v1/sign`. Wire it into the metadata
   builder (`rust/main/agents/relayer/src/msg/metadata/`) so multisig
   metadata gathering can request signatures on demand. The current
   `CheckpointSyncer::fetch_checkpoint(index)` API doesn't fit because the
   fast validator doesn't know about a checkpoint until the relayer asks.

## Layout

```
typescript/fast-validator/
├── package.json
├── tsconfig.json
├── .mocharc.json
├── README.md
├── src/
│   ├── config.ts             # YAML config schema + key loading
│   ├── merkle.ts             # branchRoot — matches Solidity MerkleLib
│   ├── server.ts             # Express HTTP server
│   ├── types.ts              # request/response Zod schemas
│   ├── verifier.ts           # Dispatch + merkle + on-chain checks, signs
│   ├── index.ts              # library entrypoint
│   └── scripts/
│       ├── run-server.ts     # CLI: starts the HTTP server
│       └── announce.ts       # CLI: signs/broadcasts ValidatorAnnounce
└── test/
    ├── merkle.test.ts        # unit tests for branchRoot
    └── digest.test.ts        # round-trip checkpoint digest signing
```
