import { Chains, HookType, OpStackHookConfig } from '@hyperlane-xyz/sdk';

export const opHookConfig: OpStackHookConfig = {
  type: HookType.OP_STACK,
  nativeBridge: '0xDa2332D0a7608919Cd331B1304Cd179129a90495',
  destinationChain: Chains.optimismgoerli,
};
