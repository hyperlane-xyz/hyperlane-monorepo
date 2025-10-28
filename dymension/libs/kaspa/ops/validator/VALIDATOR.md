# How to be a Kaspa bridge validator

## Key Generation

In hyperlane-monorepo/dymension/libs/kaspa/demo/user do `cargo run validator`.

It outputs something like

```
[
  {
    "validator_ism_addr": "0x2541ca4d67d89897d51c2bf25b1fb602eca4ae5c",
    "validator_ism_priv_key": "92940b5c00eb0e8c62f4c0d344b4fee4064c3ac51297159bf77874744e47e016",
    "validator_escrow_secret": "\"b55335e614dacb747ee4bfb5bd95e9cdb7291d32542b27924f06cb1299a2cc5a\"",
    "validator_escrow_pub_key": "0200b77b8e8f871121cda5a5c98938c7057ddee9aed930eea0dbb86dd23cbfd300",
    "multisig_escrow_addr": null
  }
]
```

Give Dymension team validator_ism_addr and validator_escrow_pub_key. Don't worry about multisig_escrow_addr. Backup the private keys.

## Config

Use the agent-config.json template provided by Dymension team. Populate .chains.<kaspa>.validatorEscrowPrivateKey with the escrow secret validator_escrow_secret (keep quotes). Also populate .valiator.key with validator_ism_priv_key. Check agent-config.example.json for an informational example.

## Running

Copy the dummy kaspa.mainnet.wallet to ~/.kaspa/kaspa.wallet: `cp <dummy> ~/.kaspa/kaspa.wallet. This wallet is just to stop the Kaspa client crashing. Signing uses the validator_escrow_secret generated before.

Make a database directory in place of your choosing

```
DB_VALIDATOR=<your directory>
```

```
export CONFIG_FILES=<path to populated agent-config.json>
ORIGIN_CHAIN=kaspatest10 # or mainnet

# in hyperlane-monorepo/rust/main
cargo build --release --bin validator

./target/release/validator \
--db $DB_VALIDATOR \
--originChainName $ORIGIN_CHAIN \
--reorgPeriod 1 \
--checkpointSyncer.type localStorage \
--checkpointSyncer.path ARBITRARY_VALUE_FOOBAR \
--metrics-port 9090 \
--log.level info
```

## Exposure

Make sure 9090 or whatever chosen metrics-port is exposed and tell Dymension team. Your validator will answer queries at that port.
