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

export type DeployedCoreAddresses = {
  mailbox: string;
  staticMerkleRootMultisigIsmFactory?: string;
  staticMessageIdMultisigIsmFactory?: string;
  validatorAnnounce: string;
  domainRoutingIsmFactory?: string;
  merkleTreeHook?: string;
  interchainGasPaymaster?: string;
};
