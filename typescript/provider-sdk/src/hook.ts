import { WithAddress } from '@hyperlane-xyz/utils';

export interface HookConfigs {
  interchainGasPaymaster: IgpHookConfig;
  merkleTreeHook: MerkleTreeHookConfig;
}
export type HookType = keyof HookConfigs;
export type HookConfig = HookConfigs[HookType];
export type DerivedHookConfig = WithAddress<HookConfig>;

export const MUTABLE_HOOK_TYPE: HookType[] = [
  'interchainGasPaymaster',
  // 'protocolFee',
  // 'routing',
  // 'fallbackRouting',
  // 'pausable',
];

export interface IgpHookConfig {
  type: 'interchainGasPaymaster';
  owner: string;
  beneficiary: string;
  oracleKey: string;
  overhead: Record<string, number>;
  oracleConfig: Record<
    string,
    {
      gasPrice: string;
      tokenExchangeRate: string;
      tokenDecimals?: number;
    }
  >;
}

export interface MerkleTreeHookConfig {
  type: 'merkleTreeHook';
}
