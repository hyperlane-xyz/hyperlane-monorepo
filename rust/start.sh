#!/bin/zsh

source ~/.zshrc

export HYP_CHAINS_ARBITRUM_CUSTOMRPCURLS=$(rpcs mainnet3 arbitrum)
export HYP_CHAINS_BASE_CUSTOMRPCURLS=$(rpcs mainnet3 base)
export HYP_CHAINS_BSC_CUSTOMRPCURLS=$(rpcs mainnet3 bsc)
export HYP_CHAINS_ETHEREUM_CUSTOMRPCURLS=$(rpcs mainnet3 ethereum)
export HYP_CHAINS_OPTIMISM_CUSTOMRPCURLS=$(rpcs mainnet3 optimism)

docker compose up -d
