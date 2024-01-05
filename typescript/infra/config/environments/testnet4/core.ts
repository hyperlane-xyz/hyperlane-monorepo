import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  ChainMap,
  CoreConfig,
  FallbackRoutingHookConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
  ProtocolFeeHookConfig,
  RoutingIsmConfig,
  buildRoutingOverAggregationIsmConfig,
  createIgpConfig,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { ethereumChainNames } from './chains';
import { storageGasOracleConfig } from './gas-oracle';
import { owners } from './owners';

// chainNames should be the most restrictive chain (like excluding solana devnet)
const igp = createIgpConfig(
  ethereumChainNames,
  storageGasOracleConfig,
  defaultMultisigConfigs,
  owners,
);

export const core: ChainMap<CoreConfig> = objMap(owners, (local, owner) => {
  const defaultIsm: RoutingIsmConfig = buildRoutingOverAggregationIsmConfig(
    local,
    owners,
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

  const aggregationHooks = objMap(
    owners,
    (_origin, _): AggregationHookConfig => ({
      type: HookType.AGGREGATION,
      hooks: [igpHook, merkleHook],
    }),
  );

  const defaultHook: FallbackRoutingHookConfig = {
    type: HookType.FALLBACK_ROUTING,
    owner,
    fallback: merkleHook,
    domains: aggregationHooks,
  };

  const requiredHook: ProtocolFeeHookConfig = {
    type: HookType.PROTOCOL_FEE,
    maxProtocolFee: ethers.utils.parseUnits('1', 'gwei').toString(), // 1 gwei of native token
    protocolFee: BigNumber.from(1).toString(), // 1 wei of native token
    beneficiary: owner,
    owner,
  };

  return {
    owner,
    defaultIsm,
    defaultHook,
    requiredHook,
  };
});
