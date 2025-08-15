## NOTES

- [ ] Launch validator and relayer
- [ ] Create ISM


# needed?
touch ~/.hyperlane/chains/dymension/tests/addresses.yaml
dasel put -f ~/.hyperlane/chains/dymension/tests/addresses.yaml 'interchainGasPaymaster' -v $NOOP_HOOK
dasel put -f ~/.hyperlane/chains/dymension/tests/addresses.yaml 'interchainSecurityModule' -v $ISM
dasel put -f ~/.hyperlane/chains/dymension/tests/addresses.yaml 'mailbox' -v $MAILBOX
dasel put -f ~/.hyperlane/chains/dymension/tests/addresses.yaml 'merkleTreeHook' -v $MERKLE_HOOK
dasel put -f ~/.hyperlane/chains/dymension/tests/addresses.yaml 'validatorAnnounce' -v $MAILBOX

dasel put -f configs/warp-route-deployment.yaml 'dymension.token' -v $TOKEN_ID
dasel put -f configs/warp-route-deployment.yaml 'dymension.foreignDeployment' -v $TOKEN_ID
dasel put -f configs/warp-route-deployment.yaml 'dymension.mailbox' -v $MAILBOX

dymd tx kas bootstrap \
  --mailbox "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" \
  --ism "0x1234567890123456789012345678901234567890" \
  --outpoint '{"transaction_id": "EiIzRFVmd4iZqrvM3e7/ABEjM0RWZ3iJmqu8zd7v/AA=", "index": 0}' \
  --from my-validator-key \
  --chain-id dymension_1100-1 \
  -y

# export AWS_ACCESS_KEY_ID=ABCDEFGHIJKLMNOP
# export AWS_SECRET_ACCESS_KEY=xX-haha-nice-try-Xx

export RELAYER_ADDR="dym15428vq2uzwhm3taey9sr9x5vm6tk78ewtfeeth" # relayer derives from HYP_KEY
export VALIDATOR_SIGNATURES_DIR=$AGENT_TMP/signatures # official name

dymd tx bank send hub-user $RELAYER_ADDR 1000000000000000000000adym "${HUB_FLAGS[@]}"


# gpt etc below
# run the Validator
./target/release/validator \
  --db $DB_VALIDATOR \
  --originChainName dymension \
  --reorgPeriod 1 \
  --validator.region us-east-1 \
  --checkpointSyncer.region us-east-1 \
  --validator.type aws \
  --chains.<your_chain_name>.signer.type aws \
  --chains.<your_chain_name>.signer.region<region_name> \
  --validator.id alias/hyperlane-validator-signer-<your_chain_name> \
  --chains.<your_chain_name>.signer.id alias/hyperlane-validator-signer-<your_chain_name> \
  --checkpointSyncer.type s3 \
  --checkpointSyncer.bucket hyperlane-validator-signatures-<your_chain_name>\


# dymd q hyperlane ism announced-storage-locations <ism> <validator>
dymd q hyperlane ism announced-storage-locations 0x726f757465725f69736d00000000000000000000000000ff0000000000000000 0xc09dddbd26fb6dcea996ba643e8c2685c03cad57


cargo build --release --bin relayer

./target/release/relayer \
    --db $DB_RELAYER \
    --relayChains anvil0,dymension \
    --allowLocalCheckpointSyncers true \
    --defaultSigner.key $HYP_KEY \
    --chains.dymension.signer.type cosmosKey \
    --chains.dymension.signer.prefix dym \
    --chains.dymension.signer.key $HYP_KEY \
    --metrics-port 9091 \
    --log.level debug 