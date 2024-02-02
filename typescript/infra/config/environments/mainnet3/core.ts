import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  ChainMap,
  CoreConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
  ProtocolFeeHookConfig,
  buildRoutingOverAggregationIsmConfig,
  createIgpConfig,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { ethereumChainNames } from './chains';
import { storageGasOracleConfig } from './gas-oracle';
import { owners as mainnetOwners, safes } from './owners';

const DEPLOYER_ADDRESS = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
const igp = createIgpConfig(
  ethereumChainNames,
  storageGasOracleConfig,
  defaultMultisigConfigs,
  mainnetOwners,
  mainnetOwners,
  mainnetOwners,
  DEPLOYER_ADDRESS,
);

// mainnetOwners should be the most restrictive chain (like excluding manta pacific)
// since the below iterates over the mainnetOwners with objMap for setting the config for each chain
export const core: ChainMap<CoreConfig> = objMap(
  mainnetOwners,
  (local, owner) => {
    const defaultIsm = buildRoutingOverAggregationIsmConfig(
      local,
      mainnetOwners,
      defaultMultisigConfigs,
      1,
    );

    const merkleHook: MerkleTreeHookConfig = {
      type: HookType.MERKLE_TREE,
    };

    const igpHook: IgpHookConfig = {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      ...igp[local],
    };

    const defaultHook: AggregationHookConfig = {
      type: HookType.AGGREGATION,
      hooks: [merkleHook, igpHook],
    };

    const requiredHook: ProtocolFeeHookConfig = {
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee: ethers.utils.parseUnits('1', 'gwei').toString(), // 1 gwei of native token
      protocolFee: BigNumber.from(0).toString(), // 0 wei
      beneficiary: owner,
      owner,
    };

    return {
      owner,
      defaultIsm,
      defaultHook,
      requiredHook,
      ownerOverrides: {
        proxyAdmin:
          local === 'arbitrum'
            ? `0xAC98b0cD1B64EA4fe133C6D2EDaf842cE5cF4b01`
            : safes[local] ?? owner,
      },
    };
  },
);
