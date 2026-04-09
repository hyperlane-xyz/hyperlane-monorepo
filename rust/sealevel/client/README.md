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

The config file is a JSON file representing the root `IsmNode`. The `"type"` field selects the ISM variant; all field names are camelCase.

#### Leaf nodes

**`trustedRelayer`** — accepts if the message was submitted by the specified relayer signer.
```json
{
  "type": "trustedRelayer",
  "relayer": "<base58 Pubkey>"
}
```

**`multisigMessageId`** — ECDSA threshold multisig over `CheckpointWithMessageId`, one validator set per origin domain.
```json
{
  "type": "multisigMessageId",
  "domainConfigs": [
    {
      "origin": 1000,
      "validators": ["0xabc123...", "0xdef456..."],
      "threshold": 2
    }
  ]
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

#### Compound nodes

**`aggregation`** — m-of-n: requires metadata from at least `threshold` sub-ISMs, and all sub-ISMs with provided metadata must verify.
```json
{
  "type": "aggregation",
  "threshold": 2,
  "sub_isms": [
    { "type": "trustedRelayer", "relayer": "<Pubkey>" },
    { "type": "test", "accept": true },
    { "type": "multisigMessageId", "domainConfigs": [...] }
  ]
}
```

**`routing`** — routes to a sub-ISM based on the message's origin domain. Falls back to `defaultIsm` if the origin has no explicit route.
```json
{
  "type": "routing",
  "routes": [
    { "domain": 1000, "ism": { "type": "trustedRelayer", "relayer": "<Pubkey>" } },
    { "domain": 2000, "ism": { "type": "test", "accept": false } }
  ],
  "defaultIsm": { "type": "pausable", "paused": false }
}
```

**`amountRouting`** — routes based on the token amount in `body[32..64]` (big-endian u256, TokenMessage format). Routes to `upper` if `amount >= threshold`, else `lower`.
```json
{
  "type": "amountRouting",
  "threshold": "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  "lower": { "type": "trustedRelayer", "relayer": "<Pubkey>" },
  "upper": { "type": "multisigMessageId", "domainConfigs": [...] }
}
```

> The `threshold` is a `"0x"`-prefixed 64-character hex string representing a 32-byte big-endian u256 (e.g. `1e18` = `0x0000...000de0b6b3a7640000`).

#### Full example

```json
{
  "type": "aggregation",
  "threshold": 1,
  "sub_isms": [
    {
      "type": "routing",
      "routes": [
        {
          "domain": 1000,
          "ism": {
            "type": "multisigMessageId",
            "domainConfigs": [
              {
                "origin": 1000,
                "validators": ["0xabcdef1234567890abcdef1234567890abcdef12"],
                "threshold": 1
              }
            ]
          }
        }
      ],
      "defaultIsm": { "type": "test", "accept": false }
    },
    {
      "type": "trustedRelayer",
      "relayer": "4Nd1mBQtrMJVYVfKf2PX98YCKvsyfDXxsY7E3D4siqYb"
    }
  ]
}
```

The `read` command outputs config in this exact format, so you can round-trip: `read` → edit → `update`.
