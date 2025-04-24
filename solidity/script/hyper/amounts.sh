CHAINS=(bsc ethereum optimism base arbitrum)

export FOUNDRY_DISABLE_NIGHTLY_WARNING="true"

arbitrumhyper="0xC9d23ED2ADB0f551369946BD377f8644cE1ca5c4"
basehyper="0xC9d23ED2ADB0f551369946BD377f8644cE1ca5c4"
bschyper="0xC9d23ED2ADB0f551369946BD377f8644cE1ca5c4"
ethereumhyper="0x93A2Db22B7c736B341C32Ff666307F4a9ED910F5"
optimismhyper="0x9923DB8d7FBAcC2E69E87fAd19b886C81cd74979"

bscsthyper="0x6E9804a08092D8ba4E69DaCF422Df12459F2599E"
ethereumsthyper="0xE1F23869776c82f691d9Cb34597Ab1830Fb0De58"

for chain in "${CHAINS[@]}"; do
  echo "Processing $chain..."
  source script/hyper/$chain-merkle-distributors.production.mainnet.env


  # if chain is ethereum then
  if [ "$chain" == "ethereum" ]; then
    TOKEN_ADDRESS=$ethereumhyper
    STAKED_TOKEN_ADDRESS=$ethereumsthyper
  elif [ "$chain" == "bsc" ]; then
    TOKEN_ADDRESS=$bschyper
    STAKED_TOKEN_ADDRESS=$bscsthyper
  elif [ "$chain" == "optimism" ]; then
    TOKEN_ADDRESS=$optimismhyper
  elif [ "$chain" == "base" ]; then
    TOKEN_ADDRESS=$basehyper
  elif [ "$chain" == "arbitrum" ]; then
    TOKEN_ADDRESS=$arbitrumhyper
  else
    echo "Unknown chain: $chain"
    continue
  fi

  BALANCE=$(cast call $TOKEN_ADDRESS "balanceOf(address) returns (uint)" $HYPER_RECIPIENT --rpc-url $DISTRIBUTION_RPC_URL | awk '{print $1}')
  DELIVERED=$(cast 2d $HYPER_AMOUNT)
  echo "  Initial HYPER $DELIVERED"
  CLAIMED=$(echo "$DELIVERED - $BALANCE" | bc)
  echo "  Claimed HYPER $CLAIMED"

  PCT=$(echo "$CLAIMED / $DELIVERED" | bc -l)

  echo "  Percentage Claimed: $PCT"

  # if chain is not ethereum or bsc then continue
  if [ "$chain" != "ethereum" ] && [ "$chain" != "bsc" ]; then
    continue
  fi

  STAKED_BALANCE=$(cast call $STAKED_TOKEN_ADDRESS "balanceOf(address) returns (uint)" $STAKED_HYPER_RECIPIENT --rpc-url $DISTRIBUTION_RPC_URL | awk '{print $1}')
  STAKED_DELIVERED=$(cast 2d $STAKED_HYPER_AMOUNT)
  echo "  Initial stHYPER $STAKED_DELIVERED"
  STAKED_CLAIMED=$(echo "$STAKED_DELIVERED - $STAKED_BALANCE" | bc)
  echo "  Claimed stHYPER $STAKED_CLAIMED"

  STAKED_PCT=$(echo "$STAKED_CLAIMED / $STAKED_DELIVERED" | bc -l)

  echo "  Percentage Claimed: $STAKED_PCT"
done
