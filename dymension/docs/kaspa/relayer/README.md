# What?

## Resources

#### Generating config

The gist: the used config is the result of a merging of different config layers https://docs.hyperlane.xyz/docs/operate/agent-config#config-layers

- https://docs.hyperlane.xyz/docs/guides/deploy-hyperlane-local-agents#2-deploy-contracts how to generate a config automatically
- https://docs.hyperlane.xyz/docs/operate/agent-config general guide
- https://docs.hyperlane.xyz/docs/operate/config-reference exhaustive
- https://docs.hyperlane.xyz/docs/operate/set-up-agent-keys keys for signing txs

#### Running

- https://docs.hyperlane.xyz/docs/guides/deploy-hyperlane-local-agents
- https://docs.hyperlane.xyz/docs/operate/relayer/run-relayer

## Instructions

```bash
# Generate an agent config - NOTE: requires local yamls which track HL contract deploments https://docs.hyperlane.xyz/docs/guides/deploy-hyperlane-local-agents#agent-configs
# TODO: not supported yet (need to check Hub, and do a workaround for Kaspa)
# TODO: Hub note: last time I tried this still doesnt work for the Hub because it doesn't populate GPRC_URLS which are a needed field, therefore some manual tweaking is needed (see https://docs.hyperlane.xyz/docs/operate/relayer/run-relayer#rpc-configuration)
hyperlane registry agent-config --chains testnet-10,dymension

# https://docs.hyperlane.xyz/docs/guides/deploy-hyperlane-local-agents#setup-directories
export CONFIG_FILES=/Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/docs/kaspa/relayer/example/config/agent-config.json

# optiona, for testing locally rather than S3. WARNING!! Do not expose private info: https://docs.hyperlane.xyz/docs/guides/deploy-hyperlane-local-agents#setup-directories
export VALIDATOR_SIGNATURES_DIR=/tmp/hyperlane-validator-signatures-<your_chain_name>

# TODO: key creation and funding relayer

cd rust/main

export HL_DB_RELAYER=/tmp/hyperlane_db_relayer
mkdir $HL_DB_RELAYER

export HYP_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

cargo run --release --bin relayer -- \
    --db $HL_DB_RELAYER \
    --relayChains kaspatest10 \
    --allowLocalCheckpointSyncers true \
    --defaultSigner.key  $HYP_KEY \
    --metrics-port 9091 \
    --log.level debug

# alternatively
cargo build --release --bin relayer
./target/release/relayer ...
```
