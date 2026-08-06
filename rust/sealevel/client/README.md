# Hyperlane Sealevel Client

CLI tool for deploying and managing Hyperlane programs on Solana/SVM chains.

## Commands

```
hyperlane-sealevel-client [OPTIONS] <COMMAND>

Commands:
  core                    Deploy core infrastructure
  mailbox                 Mailbox program interactions
  multisig-ism-message-id Multisig ISM (Message ID variant)
  composite-ism           Composite ISM (flexible tree of ISM types)
  igp                     Interchain Gas Paymaster
  validator-announce      Validator announcement
  warp-route              Warp route deployment
  ...
```

---

## composite-ism

The composite ISM stores a recursive tree of ISM nodes inline in a single PDA. The tree is defined in a JSON config file and deployed or updated in one operation.

### Subcommands

| Command | Description |
|---|---|
| `deploy` | Deploy the program and initialize with a config file |
| `update` | Replace the ISM tree on an existing deployed program |
| `read` | Print the current on-chain config as JSON (same format as input) |
| `transfer-ownership` | Transfer ownership to a new pubkey |

### Usage

```bash
# Deploy a new composite ISM
hyperlane-sealevel-client composite-ism deploy \
  --environment local-e2e \
  --environments-dir environments/ \
  --built-so-dir target/deploy \
  --chain sealeveltest1 \
  --local-domain 13375 \
  --config-file ism.json

# Update config on an existing program
hyperlane-sealevel-client composite-ism update \
  --program-id <PROGRAM_ID> \
  --config-file ism.json

# Read current on-chain config (outputs JSON to stdout)
hyperlane-sealevel-client composite-ism read --program-id <PROGRAM_ID>

# Transfer ownership
hyperlane-sealevel-client composite-ism transfer-ownership \
  --program-id <PROGRAM_ID> \
  --new-owner <NEW_OWNER_PUBKEY>
```

---

### Config File Format

The config file is a JSON file representing the root `IsmNode`. The `"type"` field selects the ISM variant. Variant names are camelCase; field names within variants are snake_case (matching the Rust struct fields exactly).

#### Leaf nodes

**`trustedRelayer`** — accepts if the message was submitted by the specified relayer signer.
```json
{
  "type": "trustedRelayer",
  "relayer": "<base58 Pubkey>"
}
```

**`multisigMessageId`** — ECDSA threshold multisig over `CheckpointWithMessageId`. Flat validators/threshold for a single validator set; use a `routing` or `fallbackRouting` parent to select different sets per origin domain.
```json
{
  "type": "multisigMessageId",
  "validators": ["0xabc123...", "0xdef456..."],
  "threshold": 2
}
```

**`test`** — always accepts or always rejects. Intended for testing only.
```json
{ "type": "test", "accept": true }
```

**`pausable`** — rejects all messages when `paused: true`. Emergency circuit breaker.
```json
{ "type": "pausable", "paused": false }
```

**`rateLimited`** — token-bucket rate limiter. Rejects messages once the bucket is empty; the bucket refills over time up to `max_capacity`. `recipient` is an optional H256 address used to restrict which message recipient this node applies to.
```json
{
  "type": "rateLimited",
  "max_capacity": 10000,
  "recipient": "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
}
```

> `recipient` is optional and may be omitted.  Mutable state (`filled_level`, `last_updated`) is managed on-chain and is never part of the config file.

#### Compound nodes

**`aggregation`** — m-of-n: requires metadata from at least `threshold` sub-ISMs, and all sub-ISMs with provided metadata must verify.
```json
{
  "type": "aggregation",
  "threshold": 2,
  "sub_isms": [
    { "type": "trustedRelayer", "relayer": "<Pubkey>" },
    { "type": "test", "accept": true },
    { "type": "multisigMessageId", "validators": ["0x..."], "threshold": 1 }
  ]
}
```

**`routing`** — routes to a per-domain sub-ISM based on the message's origin domain. Returns an error if no ISM is configured for the incoming origin. Use `fallbackRouting` if you need a catch-all.

The `domains` object maps decimal domain ID strings to ISM configs. During `deploy`/`update` each entry is submitted as a separate `SetDomainIsm` transaction.
```json
{
  "type": "routing",
  "domains": {
    "1000": { "type": "trustedRelayer", "relayer": "<Pubkey>" },
    "2000": {
      "type": "multisigMessageId",
      "validators": ["0xabc..."],
      "threshold": 1
    }
  }
}
```

**`fallbackRouting`** — like `routing`, but falls back to a statically-configured ISM program (`fallback_ism`) when the message's origin domain has no explicit override. The fallback ISM must be another deployed composite ISM program.
```json
{
  "type": "fallbackRouting",
  "fallback_ism": "<base58 Pubkey of fallback composite ISM program>",
  "domains": {
    "1000": { "type": "trustedRelayer", "relayer": "<Pubkey>" }
  }
}
```

> `domains` is optional (omitted when empty). When no per-domain ISM matches, the fallback ISM's `VerifyMetadataSpec` / `VerifyAccountMetas` / `Verify` are called via CPI.

**`amountRouting`** — routes based on the token transfer amount in `body[32..64]` (big-endian u256, TokenMessage format). Routes to `upper` if `amount >= threshold`, else `lower`. `threshold` is a decimal string representing the u256.
```json
{
  "type": "amountRouting",
  "threshold": "20000000000000000",
  "lower": { "type": "trustedRelayer", "relayer": "<Pubkey>" },
  "upper": {
    "type": "multisigMessageId",
    "validators": ["0xabc..."],
    "threshold": 1
  }
}
```

> `threshold` is a plain decimal integer string (e.g. `"20000000000000000"` for 0.02 ETH in wei units). The value is a big-endian u256.

#### Full example

A `fallbackRouting` ISM that uses a per-domain multisig for origin 1000 and falls back to a trusted-relayer composite ISM for all other origins:

```json
{
  "type": "fallbackRouting",
  "fallback_ism": "4Nd1mBQtrMJVYVfKf2PX98YCKvsyfDXxsY7E3D4siqYb",
  "domains": {
    "1000": {
      "type": "multisigMessageId",
      "validators": ["0xabcdef1234567890abcdef1234567890abcdef12"],
      "threshold": 1
    }
  }
}
```

A 1-of-2 aggregation where one branch is a multisig and the other is a trusted relayer:

```json
{
  "type": "aggregation",
  "threshold": 1,
  "sub_isms": [
    {
      "type": "multisigMessageId",
      "validators": ["0xabcdef1234567890abcdef1234567890abcdef12"],
      "threshold": 1
    },
    {
      "type": "trustedRelayer",
      "relayer": "4Nd1mBQtrMJVYVfKf2PX98YCKvsyfDXxsY7E3D4siqYb"
    }
  ]
}
```

The `read` command outputs config in this exact format, so you can round-trip: `read` → edit → `update`.
