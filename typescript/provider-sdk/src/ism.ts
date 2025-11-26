import { WithAddress } from '@hyperlane-xyz/utils';

export type IsmModuleType = {
  config: IsmConfig;
  derived: DerivedIsmConfig;
  addresses: IsmModuleAddresses;
};

export interface IsmConfigs {
  domainRoutingIsm: DomainRoutingIsmConfig;
  merkleRootMultisigIsm: MultisigIsmConfig;
  messageIdMultisigIsm: MultisigIsmConfig;
  testIsm: TestIsmConfig;
}

export type IsmType = keyof IsmConfigs;
export type IsmConfig = IsmConfigs[IsmType];
export type DerivedIsmConfig = WithAddress<IsmConfig>;

export const STATIC_ISM_TYPES: IsmType[] = [
  'merkleRootMultisigIsm',
  'messageIdMultisigIsm',
];

export interface MultisigIsmConfig {
  type: 'merkleRootMultisigIsm' | 'messageIdMultisigIsm';
  validators: string[];
  threshold: number;
}

export interface TestIsmConfig {
  type: 'testIsm';
}

export interface DomainRoutingIsmConfig {
  type: 'domainRoutingIsm';
  owner: string;
  domains: Record<string, IsmConfig | string>;
}

export type IsmModuleAddresses = {
  deployedIsm: string;
  mailbox: string;
};

export interface RawDomainRoutingIsmConfig {
  type: 'domainRoutingIsm';
  owner: string;
  domains: Record<string, string>;
}

export interface RawIsmConfigs {
  domainRoutingIsm: RawDomainRoutingIsmConfig;
  merkleRootMultisigIsm: MultisigIsmConfig;
  messageMultisigIsm: MultisigIsmConfig;
  testIsm: TestIsmConfig;
}

export interface IsmArtifact<T extends keyof RawIsmConfigs> {
  config: RawIsmConfigs[T];
  addresses: { deployedIsm: string };
}
