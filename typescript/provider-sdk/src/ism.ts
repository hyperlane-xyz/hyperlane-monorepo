import { WithAddress } from '@hyperlane-xyz/utils';

import { IsmType as AltVMIsmType } from './altvm.js';
import {
  Artifact,
  ArtifactDeployed,
  IArtifactManager,
  RawArtifact,
} from './artifact.js';
import { IIsmSigner } from './common/interfaces/ism/ism-signer.js';

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

// Artifact API types

export interface DeployedIsmAddress {
  address: string;
}

export interface IsmArtifactConfigs {
  domainRoutingIsm: RoutingIsmArtifactConfig;
  merkleRootMultisigIsm: MultisigIsmConfig;
  messageIdMultisigIsm: MultisigIsmConfig;
  testIsm: TestIsmConfig;
}

/**
 * Should be used for the specific artifact code that
 * deploys or reads any kind of ISM and its nested configs (Routing, Aggregation, ...)
 */
export type IsmArtifactConfig = IsmArtifactConfigs[IsmType];

/**
 * Describes the configuration of deployed ISM and its nested configs (Routing, Aggregation, ...)
 */
export type DeployedIsmArtifact = ArtifactDeployed<
  IsmArtifactConfig,
  DeployedIsmAddress
>;

/**
 * Should be used to implement an object/closure or class that is in charge of coordinating
 * deployment of an ISM config which might include nested ISM deployments (Routing, Aggregation, ...)
 */
export type IIsmArtifactManager = IArtifactManager<
  IsmType,
  IsmArtifactConfigs,
  DeployedIsmAddress,
  IIsmSigner
>;

export interface RoutingIsmArtifactConfig {
  type: 'domainRoutingIsm';
  owner: string;
  domains: Record<number, Artifact<IsmArtifactConfig, DeployedIsmAddress>>;
}

export type RawRoutingIsmArtifactConfig = RawArtifact<
  RoutingIsmArtifactConfig,
  DeployedIsmAddress
>;

export interface RawIsmArtifactConfigs {
  domainRoutingIsm: RawRoutingIsmArtifactConfig;
  merkleRootMultisigIsm: MultisigIsmConfig;
  messageIdMultisigIsm: MultisigIsmConfig;
  testIsm: TestIsmConfig;
}

/**
 * Should be used for the specific artifact code that
 * deploys or reads a single artifact on chain
 */
export type RawIsmArtifactConfig = RawIsmArtifactConfigs[IsmType];

/**
 * Describes the configuration of deployed ISM without nested config expansion (Routing, Aggregation, ...)
 */
export type DeployedRawIsmArtifact = ArtifactDeployed<
  RawIsmArtifactConfig,
  DeployedIsmAddress
>;

/**
 * Should be used to implement an object/closure or class that individually deploys
 * ISMs on chain
 */
export interface IRawIsmArtifactManager
  extends IArtifactManager<
    IsmType,
    RawIsmArtifactConfigs,
    DeployedIsmAddress,
    IIsmSigner
  > {
  /**
   * Read any ISM by detecting its type and delegating to the appropriate reader.
   * This is the generic entry point for reading ISMs of unknown types.
   * @param address The on-chain address of the ISM
   * @returns The artifact configuration and deployment data
   */
  readIsm(address: string): Promise<DeployedRawIsmArtifact>;
}

export function altVMIsmTypeToProviderSdkType(
  altVMType: AltVMIsmType,
): IsmType {
  const supportedTypes: AltVMIsmType[] = [
    AltVMIsmType.TEST_ISM,
    AltVMIsmType.MERKLE_ROOT_MULTISIG,
    AltVMIsmType.MESSAGE_ID_MULTISIG,
    AltVMIsmType.ROUTING,
  ];

  if (!supportedTypes.includes(altVMType)) {
    throw new Error(
      `Unsupported ISM type: AltVM ISM type ${altVMType} is not supported by the provider sdk`,
    );
  }

  // After validation, we know altVMType is one of the supported types
  // which map directly to IsmType string literals
  return altVMType as IsmType;
}
