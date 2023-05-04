# Hyperlane Sealevel (Solana VM) Integration

## Build

Contracts:

```bash
pushd programs
cargo build-sbf --arch bpf
popd
```

Test client:

```bash
pushd client
cargo build
popd
```

## Deploy and Test with Local Validator

```bash
solana-test-validator --reset
```

In a separate shell:

```bash
solana -u l program deploy target/deploy/hyperlane_sealevel_mailbox.so
solana -u l program deploy target/deploy/hyperlane_sealevel_ism_rubber_stamp.so
solana -u l program deploy target/deploy/hyperlane_sealevel_recipient_echo.so
```

```bash
RUST_LOG=debug cargo run create-accounts
RUST_LOG=debug cargo run send -m 100
RUST_LOG=debug cargo run receive
```

# Running token bridging proof of concept

### Build and run solana-test-validator

1. Clone the `solar-eclipse` repo, which is the Eclipse fork of the Solana repo. Check out the `steven/hyperlane-fix-deps` branch:

```
git clone git@github.com:Eclipse-Laboratories-Inc/solar-eclipse –branch steven/hyperlane-fix-deps
```

2. `cd` into the repo and build the `solana-test-validator` using the local `cargo` script (which ensures the correct version is used):

```
./cargo build -p solana-test-validator
```

3. Run the `solana-test-validator` with a funded test account that will later be used for deploying contracts. The account keypair & info is found in the `hyperlane-monorepo` - change the path to your local `hyperlane-monorepo` if necessary.

```
mkdir -p /tmp/eclipse/ledger-dir && target/debug/solana-test-validator --reset --ledger /tmp/eclipse/ledger-dir --account E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty ~/hyperlane-monorepo/rust/config/sealevel/test-keys/test_deployer-account.json
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

### Check out `eclipse-program-library`

This is the eclipse fork of the `solana-program-library`. Check out the branch `steven/eclipse-1.14.13`:

```
git clone git@github.com:Eclipse-Laboratories-Inc/eclipse-program-library –branch steven/eclipse-1.14.13
```

### Run the test script in `hyperlane-monorepo`

Run the script found at `rust/utils/sealevel-test.bash`. This will build all required programs, deploy contracts, and test sending a warp route message. You need to supply the paths to your local `solar-eclipse` and `eclipse-program-library` repos:

```
SOLAR_ECLIPSE_DIR=~/solar-eclipse ECLIPSE_PROGRAM_LIBRARY_DIR=~/eclipse-program-library ./utils/sealevel-test.bash token-native
```

You'll see a bunch of output here, some errors - this is a symptom of hackiness and should be addressed at some point. The errors are mostly due to the script attempting to make transactions that it's unable to yet, e.g. when a contract has not yet been deployed. Eventually you should see some logs saying `delivered: {}`. At this point, you can move on to running the validator and relayer.

### Running the validator

In a separate terminal, cd to `hyperlane-monorepo/rust`.

1. Source the env vars:

```
source ./config/sealevel/validator.env
```

2. Run the validator (the rm is to make sure the validator's DB is cleared):

```
rm -rf /tmp/SEALEVEL_DB/validator ; CONFIG_FILES=./config/sealevel/sealevel.json cargo run --bin validator
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
rm -rf /tmp/SEALEVEL_DB/relayer ; CONFIG_FILES=./config/sealevel/sealevel.json cargo run --bin relayer
```

It may take some time, but eventually you should see some ugly ERROR logs -- these seem to not be errors (and will be fixed, ofc), and are just to make it easier to see some sealevel-specific logs.

Eventually you should see a log saying "Message processed" and the original `sealevel-test.bash` script should exit with a 0 exit code.
