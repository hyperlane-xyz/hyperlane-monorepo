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
}

export interface DerivedCoreConfig extends CoreConfig {
  defaultIsm: DerivedIsmConfig;
  defaultHook: DerivedHookConfig;
  requiredHook: DerivedHookConfig;
}

// Base addresses - protocol-agnostic, without EVM-specific factories
export type BaseCoreAddresses = {
  mailbox: string;
  validatorAnnounce: string;
  proxyAdmin: string;
  testRecipient: string;
  timelockController?: string;
  interchainAccountRouter: string;
  merkleTreeHook?: string;
  interchainGasPaymaster?: string;
};

// Deployed core addresses with optional EVM factories
// This allows both EVM chains (with factories) and AltVM chains (without factories)
export type DeployedCoreAddresses = BaseCoreAddresses & {
  staticMerkleRootMultisigIsmFactory?: string;
  staticMessageIdMultisigIsmFactory?: string;
  staticAggregationIsmFactory?: string;
  staticAggregationHookFactory?: string;
  domainRoutingIsmFactory?: string;
  staticMerkleRootWeightedMultisigIsmFactory?: string;
  staticMessageIdWeightedMultisigIsmFactory?: string;
};
