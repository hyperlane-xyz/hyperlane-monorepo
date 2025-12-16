import { WithAddress } from '@hyperlane-xyz/utils';

import { IsmType as AltVMIsmType } from './altvm.js';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactOnChain,
  ArtifactState,
  IArtifactManager,
  RawArtifact,
} from './artifact.js';

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

export interface DeployedIsmAddresses {
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
  DeployedIsmAddresses
>;

/**
 * Should be used to implement an object/closure or class that is in charge of coordinating
 * deployment of an ISM config which might include nested ISM deployments (Routing, Aggregation, ...)
 */
export type IIsmArtifactManager = IArtifactManager<
  IsmType,
  IsmArtifactConfigs,
  DeployedIsmAddresses
>;

export interface RoutingIsmArtifactConfig {
  type: 'domainRoutingIsm';
  owner: string;
  domains: Record<number, Artifact<IsmArtifactConfig, DeployedIsmAddresses>>;
}

export type RawRoutingIsmArtifactConfig = RawArtifact<
  RoutingIsmArtifactConfig,
  DeployedIsmAddresses
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
 * Should be used to implement an object/closure or class that individually deploys
 * ISMs on chain
 */
export interface IRawIsmArtifactManager
  extends IArtifactManager<
    IsmType,
    RawIsmArtifactConfigs,
    DeployedIsmAddresses
  > {
  /**
   * Read any ISM by detecting its type and delegating to the appropriate reader.
   * This is the generic entry point for reading ISMs of unknown types.
   * @param address The on-chain address of the ISM
   * @returns The artifact configuration and deployment data
   */
  readIsm(address: string): Promise<DeployedIsmArtifact>;
}

export function ismOnChainAddress(
  ism: ArtifactOnChain<IsmArtifactConfig, DeployedIsmAddresses>,
): string {
  return ism.artifactState === ArtifactState.DEPLOYED
    ? ism.deployed.address
    : ism.deployed.address;
}

export function altVMIsmTypeToProviderSdkType(
  altVMType: AltVMIsmType,
): IsmType {
  switch (altVMType) {
    case AltVMIsmType.TEST_ISM:
      return AltVMIsmType.TEST_ISM;
    case AltVMIsmType.MERKLE_ROOT_MULTISIG:
      return AltVMIsmType.MERKLE_ROOT_MULTISIG;
    case AltVMIsmType.MESSAGE_ID_MULTISIG:
      return AltVMIsmType.MESSAGE_ID_MULTISIG;
    case AltVMIsmType.ROUTING:
      return AltVMIsmType.ROUTING;
    default:
      throw new Error(
        `Unsupported ISM type: AltVM ISM type ${altVMType} is not supported by the provider sdk`,
      );
  }
}
