import { WithAddress } from '@hyperlane-xyz/utils';

export interface IsmConfigs {
  domainRoutingIsm: DomainRoutingIsmConfig;
  merkleRootMultisigIsm: MultisigIsmConfig;
  messageIdMultisigIsm: MultisigIsmConfig;
  testIsm: TestIsmConfig;
}

export type IsmArtifacts = {
  domainRoutingIsm: {
    config: DomainRoutingIsmConfig;
    derived: DerivedIsmConfig;
  };
  merkleRootMultisigIsm: {
    config: MultisigIsmConfig;
    derived: DerivedIsmConfig;
  };
  messageIdMultisigIsm: {
    config: MultisigIsmConfig;
    derived: DerivedIsmConfig;
  };
  testIsm: {
    config: TestIsmConfig;
    derived: DerivedIsmConfig;
  };
};

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
