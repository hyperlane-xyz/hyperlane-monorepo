# What?

## Resources

See https://docs.hyperlane.xyz/docs/operate/relayer/run-relayer

## Instructions

```bash
# TODO: not supported yet
hyperlane registry agent-config --chains testnet-10,dymension # DO NOT USE, DOES NOT PROPERLY INCLUDE GRPC URLS, USE PRECONFIGURED

# https://docs.hyperlane.xyz/docs/guides/deploy-hyperlane-local-agents#setup-directories
export CONFIG_FILES=/Users/danwt/Documents/dym/d-hyperlane-monorepo/dymension/docs/kaspa/relayer/example/config/agent-config.json

# optiona, for testing locally rather than S3. WARNING!! Do not expose private info: https://docs.hyperlane.xyz/docs/guides/deploy-hyperlane-local-agents#setup-directories
export VALIDATOR_SIGNATURES_DIR=/tmp/hyperlane-validator-signatures-<your_chain_name>

cargo run --release --bin relayer -- \
    --db ./hyperlane_db_relayer \
    --relayChains <chain_1_name>,<chain_2_name> \
    --allowLocalCheckpointSyncers true \
    --defaultSigner.key <your_relayer_key> \
    --metrics-port 9091
```
