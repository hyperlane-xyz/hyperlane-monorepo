import { type WithAddress } from '@hyperlane-xyz/utils';

export type HookModuleType = {
  config: HookConfig;
  derived: DerivedHookConfig;
  addresses: HookModuleAddresses;
};

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
  // 'domainRoutingHook',
  // 'fallbackRoutingHook',
  // 'pausableHook',
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

export type HookModuleAddresses = {
  deployedHook: string;
  mailbox: string;
};
