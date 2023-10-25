import { BigNumber } from 'ethers';

import { Chains, HookType, OpStackHookConfig } from '@hyperlane-xyz/sdk';

import { ethereumTestnetConfigs } from './chains';

export const opHookConfig: OpStackHookConfig = {
  type: HookType.OP_STACK,
  nativeBridge: '0xDa2332D0a7608919Cd331B1304Cd179129a90495',
  destinationDomain: BigNumber.from(
    ethereumTestnetConfigs.optimismgoerli.chainId,
  ),
  destinationChain: Chains.optimismgoerli,
};

export const baseHookConfig: OpStackHookConfig = {
  type: HookType.OP_STACK,
  nativeBridge: '0x8e5693140eA606bcEB98761d9beB1BC87383706D',
  destinationDomain: BigNumber.from(ethereumTestnetConfigs.basegoerli.chainId),
  destinationChain: Chains.basegoerli,
};
