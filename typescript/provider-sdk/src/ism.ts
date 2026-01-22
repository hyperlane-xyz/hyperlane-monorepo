import {
  WithAddress,
  deepEquals,
  normalizeConfig,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { IsmType as AltVMIsmType } from './altvm.js';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactState,
  IArtifactManager,
  RawArtifact,
} from './artifact.js';
import { ChainLookup } from './chain.js';

const logger = rootLogger.child({ module: 'ism' });

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

/**
 * Converts IsmConfig (Config API) to IsmArtifactConfig (Artifact API).
 *
 * Key transformations:
 * - String chain names → numeric domain IDs (for routing ISM domains)
 * - Address string references → ArtifactUnderived objects
 * - Recursively handles nested routing ISM configurations
 * - Other ISM types (multisig, testIsm) pass through unchanged
 *
 * @param config The ISM configuration using Config API format
 * @param chainLookup Chain lookup interface for resolving chain names to domain IDs
 * @returns Artifact wrapper around IsmArtifactConfig suitable for artifact writers
 *
 * @example
 * ```typescript
 * const ismConfig: IsmConfig = {
 *   type: 'domainRoutingIsm',
 *   owner: '0x123...',
 *   domains: {
 *     ethereum: { type: 'merkleRootMultisigIsm', validators: [...], threshold: 2 },
 *     polygon: '0xabc...'
 *   }
 * };
 * const artifact = ismConfigToArtifact(ismConfig, chainLookup);
 * ```
 */
export function ismConfigToArtifact(
  config: IsmConfig,
  chainLookup: ChainLookup,
): ArtifactNew<IsmArtifactConfig> {
  switch (config.type) {
    case 'domainRoutingIsm': {
      // Handle routing ISMs - need to convert chain names to domain IDs
      const domains: Record<
        number,
        Artifact<IsmArtifactConfig, DeployedIsmAddress>
      > = {};

      for (const [chainName, nestedConfig] of Object.entries(config.domains)) {
        const domainId = chainLookup.getDomainId(chainName);
        if (domainId === null) {
          logger.warn(
            `Skipping ISM config for unknown chain: ${chainName}. ` +
              `Chain not found in chain lookup.`,
          );
          continue;
        }

        if (typeof nestedConfig === 'string') {
          // Address reference - create an UNDERIVED artifact
          domains[domainId] = {
            artifactState: ArtifactState.UNDERIVED,
            deployed: { address: nestedConfig },
          };
        } else {
          // Nested ISM config - recursively convert
          domains[domainId] = ismConfigToArtifact(nestedConfig, chainLookup);
        }
      }

      return {
        artifactState: ArtifactState.NEW,
        config: {
          type: 'domainRoutingIsm',
          owner: config.owner,
          domains,
        },
      };
    }

    case 'merkleRootMultisigIsm':
    case 'messageIdMultisigIsm':
    case 'testIsm':
      // These ISM types have identical structure between Config API and Artifact API
      return {
        artifactState: ArtifactState.NEW,
        config,
      };

    default: {
      throw new Error(`Unhandled ISM type: ${(config as any).type}`);
    }
  }
}

/**
 * Determines if a new ISM should be deployed instead of updating the existing one.
 * Deploy new ISM if:
 * - ISM type changed
 * - ISM config changed (for static/immutable ISMs: multisig, testIsm)
 *
 * For routing ISMs, compares config to determine if update is sufficient or redeploy needed.
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

  // For routing ISMs, check if config changed (owner, domains)
  // If unchanged, can update in-place; if changed, need to decide deploy vs update
  return !deepEquals(normalizedActual, normalizedExpected);
}

/**
 * Merges current and expected ISM artifacts to produce an artifact ready for deployment/update.
 *
 * Return NEW artifact only if:
 * - No current ISM exists, OR
 * - Type changed, OR
 * - ISM is immutable (static) AND config changed
 *
 * Return DEPLOYED artifact for all other cases:
 * - Static ISM with unchanged config (reuse existing address)
 * - Routing ISM (will update in-place, recursively merge domains)
 *
 * @param currentArtifact Currently deployed ISM (undefined if none exists)
 * @param expectedArtifact Desired ISM configuration (NEW or DEPLOYED artifact)
 * @returns Merged artifact (NEW for deploy, DEPLOYED for reuse/update)
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
    // Return NEW to trigger redeployment
    return {
      artifactState: ArtifactState.NEW,
      config: expectedConfig,
    };
  }

  // For static ISMs, check if config changed
  if (STATIC_ISM_TYPES.includes(expectedConfig.type)) {
    const configChanged = shouldDeployNewIsm(currentConfig, expectedConfig);
    if (configChanged) {
      // Config changed - return NEW to trigger redeployment
      return {
        artifactState: ArtifactState.NEW,
        config: expectedConfig,
      };
    }

    // Config unchanged - return DEPLOYED (reuse existing address)
    const deployedAddress =
      expectedArtifact.artifactState === ArtifactState.DEPLOYED
        ? expectedArtifact.deployed
        : currentArtifact.deployed;

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: expectedConfig,
      deployed: deployedAddress,
    };
  }

  // Routing ISM - recursively merge domains
  if (
    currentConfig.type !== 'domainRoutingIsm' ||
    expectedConfig.type !== 'domainRoutingIsm'
  ) {
    // Shouldn't happen - already checked type match above
    const deployedAddress =
      expectedArtifact.artifactState === ArtifactState.DEPLOYED
        ? expectedArtifact.deployed
        : currentArtifact.deployed;

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: expectedConfig,
      deployed: deployedAddress,
    };
  }

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

    // Determine current domain ISM artifact type
    let currentDeployedIsm: DeployedIsmArtifact | undefined;
    if (
      currentDomainIsm &&
      currentDomainIsm.artifactState === ArtifactState.DEPLOYED
    ) {
      currentDeployedIsm = currentDomainIsm;
    }

    // Recursively merge domain ISMs (handles both NEW and DEPLOYED)
    if (
      expectedDomainIsm.artifactState === ArtifactState.NEW ||
      expectedDomainIsm.artifactState === ArtifactState.DEPLOYED
    ) {
      mergedDomains[domainId] = mergeIsmArtifacts(
        currentDeployedIsm,
        expectedDomainIsm,
      );
    } else {
      // UNDERIVED - use as-is
      mergedDomains[domainId] = expectedDomainIsm;
    }
  }

  // Return DEPLOYED routing ISM with merged domains
  const deployedAddress =
    expectedArtifact.artifactState === ArtifactState.DEPLOYED
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
