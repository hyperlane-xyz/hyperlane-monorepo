# Kaspa

## Structure

```
├──  demo
│   ├──  multisig // self contained demo for most basic multisig + relayer kaspa TX flow
│   ├──  relayer // self contained demo for relayer (no HL and only one of Hub/Kasp)
│   └──  validator // self contained demo for validator (no HL and only one of Hub/Kasp)
├──  lib
│   ├──  core // shared by relayer and validator libs
│   ├──  relayer // not used by validator lib
│   └──  validator // not used by relayer lib
```

## Kaspa Cheatsheet (v1.0.0)

### Resources

API: https://api.kaspa.org/docs

### Urls

typical port alignment is

- Mainnet RPC 16110
- Mainnet P2P Listen 16111
- TestNet 10 RPC 16210
- TestNet 10 WRPC 17210
- TestNet 10 P2P Listen 16211
- TestNet 11 RPC 16310
- TestNet 11 P2P Listen 16311

### Wallet

https://kaspa-ng.org/ You can enable developer mode and choose between main and testnet

### Cmds

```bash
# node
cargo run --release --bin kaspad -- --help
cargo run --release --bin kaspad -- C <config.toml>

# Use CLI wallet (local web wasn't working)
# https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/wallet/README.md#L23
cd wallet/native
cargo run
help

# Useful
connect # connect to rpc server
monitor # watch balance
server # set rpc addr
```

Exhaustive config: https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/kaspad/src/args.rs#L27-L94

Log levels: https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/kaspad/src/args.rs#L27-L94

### Client

⚠️ ⚠️ IMPORTANT ⚠️ ⚠️

In Kaspa, clients using the high level rust lib wallet API should connect to a node via WRPC. That node must also be running a GRPC server, and it must have a UTXO index. It will not allow sending TX's if the node is unsynced or syncing.

### Units, currency and conversions

https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/consensus/core/src/constants.rs#L12-L24

### Tx Construction

**_Scripts_**

Let's first understand TX semantics.

This article (https://bitcoin.stackexchange.com/a/75169, https://developer.bitcoin.org/devguide/transactions.html#p2pkh-script-validation) explains. Each output has a script_public_key, the input that spends it has a signature_script. Take an example

```
script_public_key = OP_DUP OP_HASH160 <hash160(pubKey)> OP_EQUAL OP_CHECKSIG
signature_script = <sig> <pubkey>
// They are combined
<sig> <pubKey> OP_DUP OP_HASH160 <hash160(pubKey)> OP_EQUAL OP_CHECKSIG
```

This is run through a stack machine and the transaction is allowed if it has `true` on top at the end.

To understand we should know some popular op codes:

```
OP_CHECKSIG = it pops a pubkey and sig and it checks that a) the pubkey produced the sig,  and b) the sig is corresponds to the containing TX
OP_HASH160	= it shrinks data using a hash. It's commonly used in the above pattern
```

So this script is run over the stack machine and essentially it does

1. ensure the signing pub key of the spending tx is the one referenced in the original utxo
2. ensure the signing pub key actually signed the spending tx

Therefore ensuring that the person who spends the utxo is the person intended by the utxo creator.

**_Data structures_**

(Note: In the snippets below, our remarks are prefixed 'REMARK')

```rust
pub struct TransactionOutpoint {
    #[serde(with = "serde_bytes_fixed_ref")]
    pub transaction_id: TransactionId, // REMARK: a hash
    pub index: TransactionIndexType, // REMARK: an index (0, 1 etc)
}

// REMARK: aka Locking Script https://bitcoin.stackexchange.com/a/75169
pub struct ScriptPublicKey {
    pub version: ScriptPublicKeyVersion, // REMARK: always zero https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/crypto/txscript/src/script_class.rs#L96-L98

    /*
    REMARK: See typical patterns, but not all BTC patterns are supported on Kaspa
    Found in Kaspa:
        - p2pk https://learnmeabitcoin.com/technical/script/p2pk/
        - p2sh https://learnmeabitcoin.com/technical/script/p2sh/
    */
    pub(super) script: ScriptVec, // Kept private to preserve read-only semantics (REMARK: ??)
}

pub struct TransactionOutput {
    pub value: u64, // REMARK: in sompis. Require > 0. Max is 29 billion KAS
    pub script_public_key: ScriptPublicKey,
}

pub struct TransactionInput {
    // REMARK: what is being spent
    pub previous_outpoint: TransactionOutpoint,
    #[serde(with = "serde_bytes")]

    /*
    REMARK: the unlocking script, typically contains the signature of whoever has the relevant pub key specified by the locking script.
    Note: does NOT influence TX id.
     */
    pub signature_script: Vec<u8>, // TODO: Consider using SmallVec

    // REMARK used in conjunction with TX.lock_time for complex TX timing tricks. Out of scope.
    pub sequence: u64,

    // TODO: Since this field is used for calculating mass context free, and we already commit
    // to the mass in a dedicated field (on the tx level), it follows that this field is no longer
    // needed, and can be removed if we ever implement a v2 transaction
    pub sig_op_count: u8, // REMARK: not sure if we need to populate it
}

pub struct Transaction {
    // REMARK: semver for format and content
    pub version: u16,

    pub inputs: Vec<TransactionInput>,
    pub outputs: Vec<TransactionOutput>,

    // REMARK: dissallows accepting the TX until a wall clock time passes. Out of scope.
    pub lock_time: u64,

    /*
     REMARK: https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/consensus/core/src/subnets.rs#L130-L137
     Seems to be for special transactions
    */
    pub subnetwork_id: SubnetworkId,

    // REMARK: intended for use in conjunction with atypical subnetworks. Usually zero. https://github.com/kaspanet/rusty-kaspa/blob/eb71df4d284593fccd1342094c37edc8c000da85/consensus/src/processes/transaction_validator/tx_validation_in_isolation.rs#L126
    pub gas: u64,
    #[serde(with = "serde_bytes")]


    // REMARK: you can put arbitrary data in here. There is a size limit
    pub payload: Vec<u8>,

    /// Holds a commitment to the storage mass (KIP-0009)
    /// TODO: rename field and related methods to storage_mass
    #[serde(default)]
    mass: TransactionMass, // REMARK: aka gas/size (influences cost). Does NOT impact TX id.

    // A field that is used to cache the transaction ID.
    // Always use the corresponding self.id() instead of accessing this field directly
    #[serde(with = "serde_bytes_fixed_ref")]
    id: TransactionId, // REMARK: a hash over various things
}

```
