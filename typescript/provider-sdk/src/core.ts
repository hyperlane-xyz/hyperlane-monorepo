import type { DerivedHookConfig, HookConfig } from './hook.js';
import type { DerivedIsmConfig, IsmConfig } from './ism.js';

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

export type DeployedCoreAddresses = {
  mailbox: string;
  staticMerkleRootMultisigIsmFactory: string;
  proxyAdmin: string;
  staticMerkleRootWeightedMultisigIsmFactory: string;
  staticAggregationHookFactory: string;
  staticAggregationIsmFactory: string;
  staticMessageIdMultisigIsmFactory: string;
  staticMessageIdWeightedMultisigIsmFactory: string;
  validatorAnnounce: string;
  testRecipient: string;
  interchainAccountRouter: string;
  domainRoutingIsmFactory: string;
  merkleTreeHook?: string;
  interchainGasPaymaster?: string;
};
