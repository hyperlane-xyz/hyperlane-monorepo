import type { DerivedHookConfig, HookConfig } from './hook.js';
import type { DerivedIsmConfig, IsmConfig } from './ism.js';

export type CoreModuleType = {
  config: CoreConfig;
  derived: DerivedCoreConfig;
  addresses: DeployedCoreAddresses;
};

export interface CoreConfig {
  owner: string;
  defaultIsm: IsmConfig | string;
  defaultHook: HookConfig | string;
  requiredHook: HookConfig | string;
  proxyAdmin?: {
    owner: string;
    address?: string;
  };
}

export interface DerivedCoreConfig extends CoreConfig {
  defaultIsm: DerivedIsmConfig;
  defaultHook: DerivedHookConfig;
  requiredHook: DerivedHookConfig;
}

export type DeployedCoreAddresses = {
  staticMerkleRootMultisigIsmFactory: string;
  staticMessageIdMultisigIsmFactory: string;
  staticAggregationIsmFactory: string;
  staticAggregationHookFactory: string;
  domainRoutingIsmFactory: string;
  staticMerkleRootWeightedMultisigIsmFactory: string;
  staticMessageIdWeightedMultisigIsmFactory: string;
  mailbox: string;
  validatorAnnounce: string;
  proxyAdmin: string;
  testRecipient: string;
  timelockController?: string;
  interchainAccountRouter: string;
  merkleTreeHook?: string;
  interchainGasPaymaster?: string;
};
