import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  ChainMap,
  CoreConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
  ProtocolFeeHookConfig,
  createIgpConfig,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../contexts';
import { routingIsm } from '../../routingIsm';

import { ethereumChainNames } from './chains';
import { storageGasOracleConfig } from './gas-oracle';
import { owners, safes } from './owners';

// chain should be the most restrictive chain (like excluding manta pacific)
const DEPLOYER_ADDRESS = '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba';
const igp = createIgpConfig(
  ethereumChainNames,
  storageGasOracleConfig,
  defaultMultisigConfigs,
  owners,
  DEPLOYER_ADDRESS,
);

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm = routingIsm('mainnet3', local, Contexts.Hyperlane);

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
});
