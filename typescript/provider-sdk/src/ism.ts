import {
  WithAddress,
  assert,
  deepEquals,
  normalizeConfig,
} from '@hyperlane-xyz/utils';

import { IsmType as AltVMIsmType } from './altvm.js';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactState,
  IArtifactManager,
  RawArtifact,
  isArtifactDeployed,
  isArtifactNew,
  isArtifactUnderived,
} from './artifact.js';
import { ChainLookup } from './chain.js';

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
  'testIsm',
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
  DeployedIsmAddress
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
  extends IArtifactManager<IsmType, RawIsmArtifactConfigs, DeployedIsmAddress> {
  /**
   * Read any ISM by detecting its type and delegating to the appropriate reader.
   * This is the generic entry point for reading ISMs of unknown types.
   * @param address The on-chain address of the ISM
   * @returns The artifact configuration and deployment data
   */
  readIsm(address: string): Promise<DeployedRawIsmArtifact>;
}

/**
 * Determines if a new ISM should be deployed instead of updating the existing one.
 * Deploy new ISM if:
 * - ISM type changed
 * - ISM config changed (for static/immutable ISMs: multisig, testIsm)
 *
 * For routing ISMs, config changes don't trigger redeployment as they support updates.
 *
 * @param actual The current deployed ISM configuration
 * @param expected The desired ISM configuration
 * @returns true if a new ISM should be deployed, false if existing can be updated
 */
export function shouldDeployNewIsm(
  actual: IsmArtifactConfig,
  expected: IsmArtifactConfig,
): boolean {
  // Type changed - must deploy new
  if (actual.type !== expected.type) return true;

  // Normalize and compare configs (handles address casing, validator order, etc.)
  const normalizedActual = normalizeConfig(actual);
  const normalizedExpected = normalizeConfig(expected);

  // For static ISM types, they're immutable - must redeploy if config differs
  if (STATIC_ISM_TYPES.includes(expected.type)) {
    return !deepEquals(normalizedActual, normalizedExpected);
  }

  // For routing ISMs, they support updates - never redeploy based on config
  return false;
}

/**
 * Merges current (on-chain) and expected ISM artifacts, preserving DEPLOYED state
 * for unchanged nested ISMs in routing configurations.
 *
 * This prevents unnecessary redeployment of domain ISMs when only mutable properties
 * (like routing ISM owner) change.
 *
 * @param currentArtifact Deployed ISM artifact from chain (undefined if not deployed)
 * @param expectedArtifact Expected ISM configuration (from user config)
 * @returns Merged artifact with appropriate deployment states
 */
export function mergeIsmArtifacts(
  currentArtifact: DeployedIsmArtifact | undefined,
  expectedArtifact: ArtifactNew<IsmArtifactConfig> | DeployedIsmArtifact,
): ArtifactNew<IsmArtifactConfig> | DeployedIsmArtifact {
  const expectedConfig = expectedArtifact.config;

  // No current ISM - return expected as-is
  if (!currentArtifact) {
    return expectedArtifact;
  }

  const currentConfig = currentArtifact.config;

  // Type changed - must deploy new
  if (currentConfig.type !== expectedConfig.type) {
    return {
      artifactState: ArtifactState.NEW,
      config: expectedConfig,
    };
  }

  // For static ISMs, check if config changed
  if (STATIC_ISM_TYPES.includes(expectedConfig.type)) {
    if (shouldDeployNewIsm(currentConfig, expectedConfig)) {
      return {
        artifactState: ArtifactState.NEW,
        config: expectedConfig,
      };
    }

    const deployedAddress = isArtifactDeployed(expectedArtifact)
      ? expectedArtifact.deployed
      : currentArtifact.deployed;

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: expectedConfig,
      deployed: deployedAddress,
    };
  }

  assert(
    currentConfig.type === 'domainRoutingIsm' &&
      expectedConfig.type === 'domainRoutingIsm',
    'Expected both configs to be of type domainRoutingIsm',
  );

  // Merge domain ISMs recursively
  const mergedDomains: Record<
    number,
    Artifact<IsmArtifactConfig, DeployedIsmAddress>
  > = {};

  for (const [domainIdStr, expectedDomainIsm] of Object.entries(
    expectedConfig.domains,
  )) {
    const domainId = parseInt(domainIdStr);
    const currentDomainIsm = currentConfig.domains[domainId];

    let currentDeployedIsm: DeployedIsmArtifact | undefined;
    if (currentDomainIsm && isArtifactDeployed(currentDomainIsm)) {
      currentDeployedIsm = currentDomainIsm;
    }

    if (
      isArtifactNew(expectedDomainIsm) ||
      isArtifactDeployed(expectedDomainIsm)
    ) {
      mergedDomains[domainId] = mergeIsmArtifacts(
        currentDeployedIsm,
        expectedDomainIsm,
      );
    } else {
      mergedDomains[domainId] = expectedDomainIsm;
    }
  }

  const deployedAddress = isArtifactDeployed(expectedArtifact)
    ? expectedArtifact.deployed
    : currentArtifact.deployed;

  return {
    artifactState: ArtifactState.DEPLOYED,
    config: {
      type: 'domainRoutingIsm',
      owner: expectedConfig.owner,
      domains: mergedDomains,
    },
    deployed: deployedAddress,
  };
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

export function ismArtifactToDerivedConfig(
  artifact: DeployedIsmArtifact,
  chainLookup: ChainLookup,
): DerivedIsmConfig {
  const config = artifact.config;
  const address = artifact.deployed.address;

  switch (config.type) {
    case 'domainRoutingIsm': {
      // For routing ISMs, convert domain IDs back to chain names
      // and convert nested artifacts to IsmConfig or address strings
      const domains: Record<string, IsmConfig | string> = {};

      for (const [domainIdStr, domainArtifact] of Object.entries(
        config.domains,
      )) {
        const domainId = parseInt(domainIdStr);
        const chainName = chainLookup.getChainName(domainId);
        if (!chainName) {
          // Skip unknown domains
          continue;
        }

        if (isArtifactDeployed(domainArtifact)) {
          // Recursively convert nested ISM artifacts
          domains[chainName] = ismArtifactToDerivedConfig(
            domainArtifact,
            chainLookup,
          );
        } else if (isArtifactUnderived(domainArtifact)) {
          // Use the address string for underived artifacts
          domains[chainName] = domainArtifact.deployed.address;
        } else if (isArtifactNew(domainArtifact)) {
          throw new Error(
            `Cannot convert routing ISM to derived config: nested ISM for domain ${chainName} (${domainId}) is NEW and has no address`,
          );
        }
      }

      return {
        type: 'domainRoutingIsm',
        owner: config.owner,
        domains,
        address,
      };
    }

    case 'merkleRootMultisigIsm':
    case 'messageIdMultisigIsm':
      // Multisig ISMs have identical structure between Artifact and Config APIs
      return {
        ...config,
        address,
      };

    case 'testIsm':
      // Test ISMs have identical structure between Artifact and Config APIs
      return {
        ...config,
        address,
      };

    default: {
      const invalidConfig: never = config;
      throw new Error(`Unhandled ISM type: ${(invalidConfig as any).type}`);
    }
  }
}
