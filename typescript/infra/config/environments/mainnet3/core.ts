import { BigNumber, ethers } from 'ethers';

import {
  AggregationHookConfig,
  ChainMap,
  CoreConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
  ProtocolFeeHookConfig,
} from '@hyperlane-xyz/sdk';
import { objMap } from '@hyperlane-xyz/utils';

import { Contexts } from '../../contexts';
import { routingIsm } from '../../routingIsm';

import { igp } from './igp';
import { owners, safes } from './owners';

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
    maxProtocolFee: ethers.utils.parseUnits('1', 'gwei'), // 1 gwei of native token
    protocolFee: BigNumber.from(0), // 0 wei
    beneficiary: owner,
    owner,
  };

  // reusing mainnet2 proxyAdmins owned by safes (where available)
  const ownerOverrides = safes[local]
    ? {
        proxyAdmin:
          local === 'arbitrum'
            ? // timelock on arbitrum
              `0xAC98b0cD1B64EA4fe133C6D2EDaf842cE5cF4b01`
            : safes[local]!,
      }
    : undefined;

  return {
    owner,
    defaultIsm,
    defaultHook,
    requiredHook,
    ownerOverrides,
  };
});
