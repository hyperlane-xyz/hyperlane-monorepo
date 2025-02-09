#!/bin/zsh
setopt KSH_ARRAYS
xerc20s=(
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x5EA461E19ba6C002b7024E4A2e9CeFe79a47d3bB"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
  "0x585afea249031Ea4168A379F664e91dFc5F77E7D"
)

warpRoutes=(
  "0x3F536e156eD291c135ACb1D20F77C3B948E0F8a5"
  "0xbA6BbAe1c1d25fFdd5bB74192d687A25d5e65326"
  "0xBbcA34fF173339094cAc51e33BADeE86AA2C35b5"
  "0x89E3530137aD51743536443a3EC838b502E72eb7"
  "0x01bFbc80b32469c36DB4C7fc564E75475dfC278C"
  "0xd4C1905BB1D26BC93DAC913e13CaCC278CdCC80D"
  "0x9E3075E067932d744119e583B34d11b144CE1e4A"
  "0xdfA407edf065b7ECfD95c3c5F4C32F9f34a5Fe80"
  "0x21581dE0CB0Ce91E87b9d5124543C75Fa01ED9CC"
  "0xa2656c131A9F204F73944D7B60DDB17565E71292"
  "0x652e2F475Af7b1154817E09f5408f9011037492a"
  "0xdD313D475f8A9d81CBE2eA953a357f52e10BA357"
  "0x7712b534bF2b9fb7fA8D14EE83fDd077691a76C2"
  "0x910FF91a92c9141b8352Ad3e50cF13ef9F3169A1"
  "0xDF96074eefdD1Ae137C008bE165A3Ed4A55718FA"
)

safes=(
  "0xA9421c6F339eC414b7e77449986bE9C2Ae430C25"
  "0xA9421c6F339eC414b7e77449986bE9C2Ae430C25"
  "0xA9421c6F339eC414b7e77449986bE9C2Ae430C25"
  "0xA9421c6F339eC414b7e77449986bE9C2Ae430C25"
  "0xA9421c6F339eC414b7e77449986bE9C2Ae430C25"
  "0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115"
  "0xA9421c6F339eC414b7e77449986bE9C2Ae430C25"
  "0xA9421c6F339eC414b7e77449986bE9C2Ae430C25"
  "0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115"
  "0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115"
  "0x31FF35F84ADB120DbE089D190F03Ac74731Ae83F"
  "0xa30FF77d30Eb2d785f574344B4D11CAAe1949807"
  "0xf40b75fb85C3bEc70D75A1B45ef08FC48Db61115"
  "0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba"
  "0xf013c8Be28421b050cca5bD95cc57Af49568e8be"
)

# 'arbitrum',
# 'optimism',
# 'base',
# 'blast',
# 'bsc',
# 'mode',
# 'linea',
# 'ethereum',
# 'fraxtal',
# 'zircuit',
# 'taiko',
# 'sei',
# 'swell',
# 'unichain',
# 'berachain',
rpcs=($(rpc mainnet3 arbitrum) \
      $(rpc mainnet3 optimism) \
      $(rpc mainnet3 base) \
      $(rpc mainnet3 blast) \
      $(rpc mainnet3 bsc) \
      $(rpc mainnet3 mode) \
      $(rpc mainnet3 linea) \
      $(rpc mainnet3 ethereum) \
      $(rpc mainnet3 fraxtal) \
      $(rpc mainnet3 zircuit) \
      $(rpc mainnet3 taiko) \
      $(rpc mainnet3 sei) \
      $(rpc mainnet3 swell) \
      $(rpc mainnet3 unichain) \
      $(rpc mainnet3 berachain))


# Path to the JSON file
txFiles[42161]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/arbitrum-gnosisSafeTxBuilder-1739078009509-receipts.json"
txFiles[10]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/optimism-gnosisSafeTxBuilder-1739078001958-receipts.json"
txFiles[8453]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/base-gnosisSafeTxBuilder-1739078008615-receipts.json"
txFiles[81457]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/blast-gnosisSafeTxBuilder-1739078002660-receipts.json"
txFiles[56]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/bsc-gnosisSafeTxBuilder-1739078001396-receipts.json"
txFiles[34443]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/mode-gnosisSafeTxBuilder-1739078001711-receipts.json"
txFiles[59144]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/linea-gnosisSafeTxBuilder-1739078005551-receipts.json"
txFiles[1]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/ethereum-gnosisSafeTxBuilder-1739078002227-receipts.json"
txFiles[252]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/ethereum-gnosisSafeTxBuilder-1739078002227-receipts.json"
txFiles[48900]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/zircuit-gnosisSafeTxBuilder-1739078002032-receipts.json"
txFiles[167000]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/taiko-gnosisSafeTxBuilder-1739078001761-receipts.json"
txFiles[1329]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/sei-gnosisSafeTxBuilder-1739078001108-receipts.json"
txFiles[1923]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/swell-gnosisSafeTxBuilder-1739078006089-receipts.json"
txFiles[130]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/berachain-gnosisSafeTxBuilder-1739078001560-receipts.json"
txFiles[80094]="/Users/leyu/Desktop/Code/hyperlane/hyperlane-monorepo/typescript/cli/generated/transactions/berachain-gnosisSafeTxBuilder-1739078001560-receipts.json"

# Uni bera eth
targetChainIds=(130 80094 1)
for ((i=0; i<${#rpcs[@]}; i++)); do
  CHAIN_ID=$(cast chain-id --rpc-url ${rpcs[$i]})
  PORT=$((8549 + i))
  LOCAL_RPC_URL=http://localhost:$PORT

  echo "==========FORKING $CHAIN_ID=========="
  anvil -p $PORT --fork-url ${rpcs[$i]} --gas-price 0&
  sleep 2
  echo "==========SET MINT/BURN=========="
  XERC20_OWNER=$(cast call ${xerc20s[$i]} "owner()(address)" --rpc-url $LOCAL_RPC_URL)
  cast rpc anvil_setBalance  $XERC20_OWNER 1000000000000000000 --rpc-url $LOCAL_RPC_URL
  cast rpc anvil_impersonateAccount $XERC20_OWNER --rpc-url $LOCAL_RPC_URL
  cast send ${xerc20s[$i]} "setLimits(address,uint256,uint256)" ${warpRoutes[$i]} 100000000000 100000000000 --rpc-url $LOCAL_RPC_URL --from $XERC20_OWNER ${warpRoutes[$i]} --unlocked --gas-limit 1000000
  echo "Mint limit $(cast call ${xerc20s[$i]} "mintingMaxLimitOf(address)(uint256)" ${warpRoutes[$i]} --rpc-url $LOCAL_RPC_URL)"
  echo "Burn limit $(cast call ${xerc20s[$i]} "burningMaxLimitOf(address)(uint256)" ${warpRoutes[$i]} --rpc-url $LOCAL_RPC_URL)"
  cast rpc anvil_stopImpersonatingAccount $XERC20_OWNER --rpc-url $LOCAL_RPC_URL

  # Impersonate the warp route and mint the private key's address some xerc20
  sleep 2
  echo "==========IMPERSONATING WARP ROUTE AND MINTING XERC20=========="
  cast rpc anvil_setBalance ${warpRoutes[$i]} 1000000000000000000 --rpc-url $LOCAL_RPC_URL
  cast balance ${warpRoutes[$i]} --rpc-url $LOCAL_RPC_URL
  cast rpc anvil_impersonateAccount ${warpRoutes[$i]} --rpc-url $LOCAL_RPC_URL
  cast send ${xerc20s[$i]} "mint(address,uint256)" 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 100 --rpc-url $LOCAL_RPC_URL --from ${warpRoutes[$i]} --unlocked --gas-limit 1000000
  cast rpc anvil_stopImpersonatingAccount ${warpRoutes[$i]} --rpc-url $LOCAL_RPC_URL

  # Read the file and look for the setDestinationGas() function signature
  echo "==========READING setDestinationGas()=========="
  FILE="${txFiles[$CHAIN_ID]}"
  setDestinationCallData=$(perl -nle 'print $1 if /(0xb1bd6436.{1920})/' "$FILE")

  if [ -z "$setDestinationCallData" ]; then
    echo "setDestinationGas() calldata not found in GnosisSafeBuilder file for chain $CHAIN_ID"
    exit 1
  fi

  # Impersonate Safe and apply the enrollRemoteRouter() tx
  echo "==========APPLYING setDestinationGas()=========="
  WARP_ROUTE_OWNER=$(cast call ${warpRoutes[$i]} "owner()(address)" --rpc-url $LOCAL_RPC_URL)
  cast rpc anvil_setBalance ${WARP_ROUTE_OWNER} 100000000000000000 --rpc-url $LOCAL_RPC_URL
  cast balance ${WARP_ROUTE_OWNER} --rpc-url $LOCAL_RPC_URL
  cast rpc anvil_impersonateAccount $WARP_ROUTE_OWNER --rpc-url $LOCAL_RPC_URL
  cast send ${warpRoutes[$i]} $setDestinationCallData --rpc-url $LOCAL_RPC_URL --from $WARP_ROUTE_OWNER --unlocked --gas-limit 10000000
  cast rpc anvil_stopImpersonatingAccount $WARP_ROUTE_OWNER --rpc-url $LOCAL_RPC_URL

  # Read the file and look for the setInterchainSecurityModule() function signature (exclude bera and uni)
  echo "==========READING setInterchainSecurityModule()=========="
  FILE="${txFiles[$CHAIN_ID]}"
  setInterchainSecurity=$(perl -nle 'print $1 if /(0x0e72cc06.{64})/' "$FILE")
  if [ -z "$setInterchainSecurity" ] && ([ $CHAIN_ID != 130 ] && [ $CHAIN_ID != 80094 ]); then
    echo "setInterchainSecurityModule() calldata not found in GnosisSafeBuilder file for chain $CHAIN_ID"
    exit 1
  fi

  # Read the file and look for the enrollRemote() function signature
  echo "==========READING enrollRemote()=========="
  FILE="${txFiles[$CHAIN_ID]}"
  enrollRemoteRouterCallData=$(perl -nle 'print $1 if /(0xe9198bf9(?:.{1920}|.{512}))/' "$FILE")

  if [ -z "$enrollRemoteRouterCallData" ]; then
    echo "enrollRemoteRouter() calldata not found in GnosisSafeBuilder file for chain $CHAIN_ID"
    exit 1
  fi

  echo "==========APPLYING enrollRemote()=========="
  # Impersonate Safe and apply the enrollRemoteRouter() tx
  WARP_ROUTE_OWNER=$(cast call ${warpRoutes[$i]} "owner()(address)" --rpc-url $LOCAL_RPC_URL)
  cast rpc anvil_setBalance ${WARP_ROUTE_OWNER} 100000000000000000 --rpc-url $LOCAL_RPC_URL
  cast balance ${WARP_ROUTE_OWNER} --rpc-url $LOCAL_RPC_URL
  cast rpc anvil_impersonateAccount $WARP_ROUTE_OWNER --rpc-url $LOCAL_RPC_URL
  cast send ${warpRoutes[$i]} $enrollRemoteRouterCallData --rpc-url $LOCAL_RPC_URL --from $WARP_ROUTE_OWNER --unlocked --gas-limit 10000000
  cast rpc anvil_stopImpersonatingAccount $WARP_ROUTE_OWNER --rpc-url $LOCAL_RPC_URL

  # approve 
  echo "==========APPROVING TOKEN ALLOWANCES=========="
  cast send ${xerc20s[$i]} "approve(address,uint256)(bool)" ${warpRoutes[$i]} 10000000000000000000 --rpc-url $LOCAL_RPC_URL --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  cast call ${xerc20s[$i]} "allowance(address owner, address spender)(uint256)" 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 ${warpRoutes[$i]} --rpc-url $LOCAL_RPC_URL

  # approve the Lockboxed Collateral if on ethereum
  if [[ $CHAIN_ID == 1 ]]; then
    echo "==========APPROVING LOCKBOX COLLATERAL ALLOWANCES ON ETH=========="
    COLLATERAL_ON_ETH=0x688eBadf27a256Ed1D402be628011C37E81f1682
    cast send ${COLLATERAL_ON_ETH} "mint(uint256)" 10000000000000000000 --rpc-url $LOCAL_RPC_URL --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
    cast rpc anvil_stopImpersonatingAccount ${COLLATERAL_ON_ETH} --rpc-url $LOCAL_RPC_URL
    cast send $COLLATERAL_ON_ETH "approve(address,uint256)(bool)" ${warpRoutes[$i]} 10000000000000000000 --rpc-url $LOCAL_RPC_URL --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
    cast call $COLLATERAL_ON_ETH "allowance(address owner, address spender)(uint256)" 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 ${warpRoutes[$i]} --rpc-url $LOCAL_RPC_URL
  fi
  
  # transfer remote to each target chain
  for targetChainId in "${targetChainIds[@]}"; do
    sleep 1
    if [[ $targetChainId != $CHAIN_ID ]]; then
      # transfer remote and grep the logs for InsertedIntoTree and GasPayment topics
      echo "==========SENDING TRANSFER REMOTE from $CHAIN_ID to $targetChainId=========="
      transactionWithLogs=$(cast send ${warpRoutes[$i]} "transferRemote(uint32,bytes32,uint256)" ${targetChainId} "000000000000000000000000a7eccdb9be08178f896c26b7bbd8c3d4e844d9ba" 1 --rpc-url $LOCAL_RPC_URL --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80  --value 25000000000000000000| grep 0x65695c3748edae85a24cc2c60b299b31f463050bc259150d2e5802ec8d11720a | grep 0x253a3a04cab70d47c1504809242d9350cd81627b4f1d50753e159cf8cd76ed33)
      echo "Transaction logs $transactionWithLogs"
      if [ -z "$transactionWithLogs" ]; then
        echo "==========InsertedIntoTree and GasPayment topics not found!!!=========="
        exit 1
      fi
      echo "==========Success transferRemote!=========="
    fi
  done

  pkill -f anvil
done

####### The script below is for setting XERC20 Limits #######

# export HYPERLANE_MONOREPO="$HOME/Desktop/code/hyperlane/hyperlane-monorepo"
# hypkey() {
#   # First param or default to mainnet3
#   HYP_ENVIRONMENT="${1:-mainnet3}"
#   # Second param or default to deployer
#   HYP_KEY_ROLE="${2:-deployer}"

#   # get the key
#   yarn --cwd $HYPERLANE_MONOREPO/typescript/infra --silent run tsx $HYPERLANE_MONOREPO/typescript/infra/scripts/keys/get-key.ts -e $HYP_ENVIRONMENT --role $HYP_KEY_ROLE
# }

# # Set xerc20 mint/burn limits
# for ((i=0; i<${#xerc20s[@]}; i++)); do
#     echo "${xerc20s[$i]}"
#     echo "${warpRoutes[$i]}"
#     echo "${rpcs[$i]}"
#     cast send ${xerc20s[$i]} "setLimits(address, uint256, uint256)" ${warpRoutes[$i]} 100000000000000000000 100000000000000000000 --rpc-url ${rpcs[$i]} --private-key `hypkey`
# done
