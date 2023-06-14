# Hyperlane Sealevel (Solana VM) Integration

# Running local end to end test

A local end to end test has been written that will:

1. Run a local Solana network
2. Deploy two sets of core contracts (i.e. Mailbox / Multisig ISM / ValidatorAnnounce) onto this chain, one with domain 13375 and the other 13376.
3. Deploy a "native" warp route on domain 13375 and a "synthetic" warp route on domain 13376
4. Send native lamports from domain 13375 to 13376
5. A validator & relayer can then be spun up to deliver the message

### Build and run solana-test-validator

This only needs to be done once when initially setting things up.

1. Clone the `solar-eclipse` repo, which is the Eclipse fork of the Solana repo. This is needed to run the local Solana network. Check out the `steven/hyperlane-fix-deps` branch:

```
git clone git@github.com:Eclipse-Laboratories-Inc/solar-eclipse --branch steven/hyperlane-fix-deps
```

2. `cd` into the repo and build the `solana-test-validator` using the local `cargo` script (which ensures the correct version is used):

```
./cargo build -p solana-test-validator
```

### Check out `eclipse-program-library`

This is a fork (with some dependency fixes) of the eclipse fork of the `solana-program-library`. This contains "SPL" programs that are commonly used programs - stuff like the token program, etc.

1. Check out the branch `trevor/steven/eclipse-1.14.13/with-tlv-lib`:

```
git clone git@github.com:tkporter/eclipse-program-library.git --branch trevor/steven/eclipse-1.14.13/with-tlv-lib
```

### Build the required SPL programs and Hyperlane programs

This command will build all the required SPL programs (e.g. the token program, token 2022 program, SPL noop, etc...) found in the local repo of `eclipse-program-library`,
and will build all the required Hyperlane programs (e.g. the Mailbox program, Validator Announce, etc...).

You need to run this if any changes are made to programs that you want to be used in future runs of the end to end test.

Change the paths to your local `solar-eclipse` repo and `eclipse-program-library` as necessary, and run this from the `rust` directory of hyperlane-monorepo.

```
SOLAR_ECLIPSE_DIR=~/solar-eclipse ECLIPSE_PROGRAM_LIBRARY_DIR=~/eclipse-program-library ./utils/sealevel-test.bash build-only
```

### Run the local Solana network

This will run the `solana-test-validator` with a funded test account `E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty` that will later be used for deploying contracts. It will also create some of the required SPL programs at the specified program IDs - these program IDs are consistent across Solana networks and are required by our Hyperlane programs. Change paths as necessary - the \*.so files should have been created by the prior command. The `--ledger` directory is arbitrary and is just the data dir for the Solana validator.

```
mkdir -p /tmp/eclipse/ledger-dir && target/debug/solana-test-validator --reset --ledger /tmp/eclipse/ledger-dir --account E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty ~/abacus-monorepo/rust/config/sealevel/test-keys/test_deployer-account.json --bpf-program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA ~/eclipse-program-library/target/deploy/spl_token.so --bpf-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb ~/eclipse-program-library/target/deploy/spl_token_2022.so --bpf-program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL ~/eclipse-program-library/target/deploy/spl_associated_token_account.so --bpf-program noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV ~/eclipse-program-library/account-compression/target/deploy/spl_noop.so
```

By now you should have an output like this - keep it running and move to another terminal:

```
Ledger location: /tmp/eclipse/ledger-dir
Log: /tmp/eclipse/ledger-dir/validator.log
⠒ Initializing...
⠄ Initializing...
Identity: 4P5rtWdphhehU32myNQcTSMgrCRz7kdvZEnasX6fahJQ
Genesis Hash: G7CY7wEzbdjh8RwqTszxrpYTqiHKvqwpaw3JbmKJjJhU
Version: 1.14.13
Shred Version: 419
Gossip Address: 127.0.0.1:1024
TPU Address: 127.0.0.1:1027
JSON RPC URL: http://127.0.0.1:8899
⠒ 00:05:35 | Processed Slot: 668 | Confirmed Slot: 668 | Finalized Slot: 6
```

### Run the local end to end script

Run the script found at `rust/utils/sealevel-test.bash`. This will build all required programs, deploy contracts, and test sending a warp route message. You need to supply the paths to your local `solar-eclipse` and `eclipse-program-library` repos:

```
SOLAR_ECLIPSE_DIR=~/solar-eclipse ECLIPSE_PROGRAM_LIBRARY_DIR=~/eclipse-program-library ./utils/sealevel-test.bash
```

Note: this won't rebuild any of the programs. If you want to rebuild them, you can either cd into them individually and run `cargo build-sbf --arch sbf`, or you can run the above bash script with `force-build-programs` as the first argument.

You'll see a bunch of output here showing programs being built and deployed. Eventually you should see some logs saying `grep -q 'Message not delivered'`. At this point, the contracts have all been deployed and a native warp route transfer has been made. You can move on to running the validator and relayer.

### Running the validator

In a separate terminal, cd to `hyperlane-monorepo/rust`.

1. Source the env vars:

```
source ./config/sealevel/validator.env
```

2. Run the validator (this clears the DB / checkpoints if present):

```
mkdir /tmp/SEALEVEL_DB ; rm -rf /tmp/SEALEVEL_DB/validator /tmp/test_sealevel_checkpoints_0x70997970c51812dc3a010c7d01b50e0d17dc79c8/* ; CONFIG_FILES=./config/sealevel/sealevel.json cargo run --bin validator
```

You should see some INFO logs about checkpoint at index 0.

You can confirm things are working correctly by looking at `/tmp/CHECKPOINTS_DIR`, where the validator posts its signatures.

### Running the relayer

In a separate terminal, again in `hyperlane-monorepo/rust`:

1. Source the env vars:

```
source ./config/sealevel/relayer.env
```

2. Run the relayer (the rm is to make sure the relayer's DB is cleared):

```
rm -rf /tmp/SEALEVEL_DB/relayer ; RUST_BACKTRACE=full CONFIG_FILES=./config/sealevel/sealevel.json cargo run --bin relayer
```

When the original `sealevel-test.bash` exits with a 0 exit code and some logs about Hyperlane Token Storage, the message has been successfully delivered!
