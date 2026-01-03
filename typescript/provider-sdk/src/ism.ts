import { WithAddress } from '@hyperlane-xyz/utils';

import {
  Artifact,
  ArtifactReader,
  ArtifactWriter,
  RawArtifact,
} from './module.js';

export type IsmModuleType = {
  config: IsmConfig;
  derived: DerivedIsmConfig;
  addresses: IsmModuleAddresses;
};

export interface MultisigIsmConfig {
  type: 'merkleRootMultisigIsm' | 'messageIdMultisigIsm';
  validators: string[];
  threshold: number;
}

export interface TestIsmConfig {
  type: 'testIsm';
}

// Legacy type for AltVM modules - domains are plain IsmConfig
export interface DomainRoutingIsmConfig {
  type: 'domainRoutingIsm';
  owner: string;
  domains: Record<string, IsmConfig>;
}

// Artifact type for protocol providers - domains are Artifact<IsmArtifactConfig>
export interface DomainRoutingIsmArtifactConfig {
  type: 'domainRoutingIsm';
  owner: string;
  domains: Record<string, Artifact<IsmArtifactConfig>>;
}

// Legacy union type for AltVM modules
export type IsmConfig =
  | DomainRoutingIsmConfig
  | MultisigIsmConfig
  | TestIsmConfig;

// Artifact union type for artifact API
export type IsmArtifactConfig =
  | DomainRoutingIsmArtifactConfig
  | MultisigIsmConfig
  | TestIsmConfig;

// Type map for artifact API
export interface IsmConfigs {
  domainRoutingIsm: DomainRoutingIsmArtifactConfig;
  merkleRootMultisigIsm: MultisigIsmConfig;
  messageIdMultisigIsm: MultisigIsmConfig;
  testIsm: TestIsmConfig;
}

export type IsmType = keyof IsmConfigs;
export type DerivedIsmConfig = WithAddress<IsmConfig>;

export const STATIC_ISM_TYPES: IsmType[] = [
  'merkleRootMultisigIsm',
  'messageIdMultisigIsm',
];

export interface DerivedIsm {
  address: string;
}

export interface RawIsmConfigs {
  domainRoutingIsm: RawArtifact<DomainRoutingIsmArtifactConfig, DerivedIsm>;
}

export type IsmModuleAddresses = {
  deployedIsm: string;
  mailbox: string;
};

// Artifact types for creating ISMs
export type IsmArtifact<T extends IsmType> = Artifact<IsmConfigs[T]>;

// Raw artifact types for reading from chain (protocol providers)
export type RawIsmArtifact<T extends IsmType> = T extends keyof RawIsmConfigs
  ? RawIsmConfigs[T]
  : IsmConfigs[T];

// Convenience type aliases
export type RawDomainRoutingIsmConfig = RawIsmConfigs['domainRoutingIsm'];

// Reader/Writer types for creating ISMs
export type IsmArtifactReader<T extends IsmType> = ArtifactReader<
  IsmConfigs[T],
  DerivedIsm
>;
export type IsmArtifactWriter<T extends IsmType> = ArtifactWriter<
  IsmConfigs[T],
  DerivedIsm
>;

// Reader/Writer types for protocol providers (using raw types)
export type RawIsmArtifactReader<T extends IsmType> = ArtifactReader<
  RawIsmArtifact<T>,
  DerivedIsm
>;
export type RawIsmArtifactWriter<T extends IsmType> = ArtifactWriter<
  RawIsmArtifact<T>,
  DerivedIsm
>;
