## What?

Demonstrates the simplest possible validator + relayer multisig flow. 'Validators' represented by randomized in memory private keys create an escrow address. A local wallet instance with testnet tokens plays the roles of 'user' and also 'relayer'.

The user deposits to the escrow address and then relayer constructs a TX to withdraw from the escrow back to user. The construction is via PSKT and includes both a relayer paid network fee, and the escrow multisig sigs from the validators.

## Instructions

### Tools

```bash
rustup update

cargo version
# cargo 1.87.0 (99624be96 2025-05-06)
rustc -V
# rustc 1.87.0 (17067e9ac 2025-05-09)

# Tested with https://github.com/kaspanet/rusty-kaspa v1.0.0 (Crescendo)
```

### Resources

TN10 is running v1.0.0 https://wiki.kaspa.org/en/testnets
Endpoint: https://api-tn10.kaspa.org/
Faucet: https://faucet-tn10.kaspanet.io/

### Node

```bash
# launch a node which can be used as an RPC server
cargo run --release --bin kaspad -- -C /Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/libs/kaspa/demo-multisig/kaspad.toml
```

### Program

```bash
cargo run # it will generate a private key, then fund it
cargo run -- -k $PRIVATE_KEY
```

## Multisig Theory

### Theory

TODO:

### TX construction

**_PSKT_**

Partially signed kaspa transactions (spec: https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki, https://github.com/bitcoin/bips/blob/master/bip-0370.mediawiki#creator) let actors cooperate.

See the role diagram for a clue https://www.notion.so/dymension/ADR-Kaspa-Bridge-Off-Chain-20da4a51f86a8026aa10e2c616a1b9f5?source=copy_link#20da4a51f86a8023bdcce2a7f0f49527

**_Setup_**

Validators need to create key pairs and collaborate to make a multisig redeem script (https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/crypto/txscript/src/standard/multisig.rs#L18).

They will need to publish the script_public_key (p2sh) which can be generated (https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/consensus/client/src/utils.rs#L30).

Actually there is a util to combine this (https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/wallet/core/src/derivation.rs#L442-L456).

Users will escrow to that address.

**_Construction (relayer)_** (https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki#creator)

Relayer will construct the TX with ALL inputs and outputs (i.e. for escrow and for network fees). It must use ANYONE CAN PAY hash function for the inputs. It will produce a PSKT.

It will gather partially signed inputs from the validators, and then combine them. It will also it's own fee input.

Afterwards it delivers to network.

**_Signing (validators)_** (https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki#signer)

They will provide signatures for only the inputs that spend the escrow, and also the sig will be over _all_ outputs too.

**_Transport_**

Use bundle (https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/wallet/pskt/src/bundle.rs#L23) for transport. There is no out of the box communication library, so some suitable thing should be used (e.g. libp2p).

### Src and refs

- Sig definitions https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/crypto/txscript/src/lib.rs#L55-L65
- PSKT Multisig examples https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/wallet/pskt/examples/multisig.rs#L12

### Appendix

_Factoids_

Learned on discord:

"Segwit (Bitcoin https://learnmeabitcoin.com/technical/upgrades/segregated-witness/) is not in Kaspa because Kaspa TX ID doesn't include script signature (https://github.com/kaspanet/rusty-kaspa/blob/eaadfa6230fc376f314d9a504c4c70fbc0416844/consensus/core/src/hashing/tx.rs#L20)"

"Multisig upper bound is N=20"

"There are 3 types of addresses currently: schnorr, ecdsa, script. So natively there's no support of multisig. Multisig is only implemented as p2sh. Probably Frost threshold scheme can be used to work with a single schnorr signature and multiple parties, but it's a completely different story"

_Frost_

- https://tlu.tarilabs.com/cryptography-101/module2-introduction-schnorr-signatures#basics-of-schnorr-signatures
- https://frost.zfnd.org/frost.html
- https://github.com/ZcashFoundation/frost
- https://github.com/ZcashFoundation/frost-zcash-demo

_PSKT Gotchas_

TODO:
