import {
  WithAddress,
  assert,
  deepEquals,
  isNullish,
  normalizeConfig,
} from '@hyperlane-xyz/utils';

import { IsmType as AltVMIsmType } from './altvm.js';
import {
  Artifact,
  ArtifactDeployed,
  ArtifactNew,
  ArtifactState,
  ConfigOnChain,
  IArtifactManager,
  isArtifactDeployed,
  isArtifactNew,
  isArtifactUnderived,
} from './artifact.js';
import { ChainLookup } from './chain.js';

function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ISM type in ${context}: ${JSON.stringify(value)}`);
}

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
  compositeIsm: CompositeIsmConfig;
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

/**
 * A node in a Sealevel-only "composite ISM" tree (one program storing the
 * whole tree in a single PDA). Sub-nodes are inline Borsh data, not separate
 * deployments — only `routing`/`fallbackRouting.domains` are chain-name keyed
 * (config-file-only; diffed into per-domain instructions by the writer).
 */
export type CompositeIsmNodeConfig =
  | { type: 'trustedRelayer'; relayer: string }
  | { type: 'multisigMessageId'; validators: string[]; threshold: number }
  | {
      type: 'aggregation';
      threshold: number;
      subIsms: CompositeIsmNodeConfig[];
    }
  | { type: 'test'; accept: boolean }
  | { type: 'pausable'; paused: boolean }
  | {
      type: 'amountRouting';
      threshold: string;
      lower: CompositeIsmNodeConfig;
      upper: CompositeIsmNodeConfig;
    }
  | {
      type: 'rateLimited';
      maxCapacity: string;
      mailbox: string;
      recipient?: string;
    }
  | { type: 'routing'; domains?: Record<string, CompositeIsmNodeConfig> }
  | {
      type: 'fallbackRouting';
      fallbackIsm: string;
      domains?: Record<string, CompositeIsmNodeConfig>;
    };

export interface CompositeIsmConfig {
  type: 'compositeIsm';
  owner: string;
  root: CompositeIsmNodeConfig;
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
  compositeIsm: CompositeIsmArtifactConfig;
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

export type RawRoutingIsmArtifactConfig =
  ConfigOnChain<RoutingIsmArtifactConfig>;

/**
 * Artifact-API mirror of CompositeIsmNodeConfig: `routing`/`fallbackRouting.domains`
 * are keyed by domain ID instead of chain name. Otherwise identical — sub-nodes
 * are never separately-deployed Artifacts, so there's no distinct "raw" shape
 * (unlike domainRoutingIsm, whose domains wrap nested Artifact<> objects).
 */
export type CompositeIsmNodeArtifactConfig =
  | { type: 'trustedRelayer'; relayer: string }
  | { type: 'multisigMessageId'; validators: string[]; threshold: number }
  | {
      type: 'aggregation';
      threshold: number;
      subIsms: CompositeIsmNodeArtifactConfig[];
    }
  | { type: 'test'; accept: boolean }
  | { type: 'pausable'; paused: boolean }
  | {
      type: 'amountRouting';
      threshold: string;
      lower: CompositeIsmNodeArtifactConfig;
      upper: CompositeIsmNodeArtifactConfig;
    }
  | {
      type: 'rateLimited';
      maxCapacity: string;
      mailbox: string;
      recipient?: string;
    }
  | {
      type: 'routing';
      domains?: Record<number, CompositeIsmNodeArtifactConfig>;
    }
  | {
      type: 'fallbackRouting';
      fallbackIsm: string;
      domains?: Record<number, CompositeIsmNodeArtifactConfig>;
    };

export interface CompositeIsmArtifactConfig {
  type: 'compositeIsm';
  owner: string;
  root: CompositeIsmNodeArtifactConfig;
}

export interface RawIsmArtifactConfigs {
  domainRoutingIsm: RawRoutingIsmArtifactConfig;
  merkleRootMultisigIsm: MultisigIsmConfig;
  messageIdMultisigIsm: MultisigIsmConfig;
  testIsm: TestIsmConfig;
  compositeIsm: CompositeIsmArtifactConfig;
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
export interface IRawIsmArtifactManager extends IArtifactManager<
  IsmType,
  RawIsmArtifactConfigs,
  DeployedIsmAddress
> {
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

  // Composite ISM's tree is diffed by SvmCompositeIsmWriter.update() itself
  // (it re-reads on-chain state directly) rather than via this generic
  // Artifact recursion, since sub-nodes aren't separate deployments.
  if (expectedConfig.type === 'compositeIsm') {
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
    const currentDomainIsm = Object.prototype.hasOwnProperty.call(
      currentConfig.domains,
      domainId,
    )
      ? currentConfig.domains[domainId]
      : undefined;

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
  switch (altVMType) {
    case AltVMIsmType.TEST_ISM:
      return 'testIsm';
    case AltVMIsmType.MERKLE_ROOT_MULTISIG:
      return 'merkleRootMultisigIsm';
    case AltVMIsmType.MESSAGE_ID_MULTISIG:
      return 'messageIdMultisigIsm';
    case AltVMIsmType.ROUTING:
      return 'domainRoutingIsm';
    case AltVMIsmType.COMPOSITE:
      return 'compositeIsm';
    default:
      throw new Error(
        `Unsupported ISM type: AltVM ISM type ${altVMType} is not supported by the provider sdk`,
      );
  }
}

/**
 * Recursively converts a composite ISM node from the Artifact API shape
 * (domain-ID-keyed `domains`) to the Config API shape (chain-name-keyed).
 * Only `routing`/`fallbackRouting.domains` need key conversion — `subIsms`
 * (array) and `amountRouting.lower`/`upper` (fixed fields) don't.
 */
function compositeIsmNodeArtifactToConfig(
  node: CompositeIsmNodeArtifactConfig,
  chainLookup: ChainLookup,
): CompositeIsmNodeConfig {
  switch (node.type) {
    case 'aggregation':
      return {
        ...node,
        subIsms: node.subIsms.map((sub) =>
          compositeIsmNodeArtifactToConfig(sub, chainLookup),
        ),
      };
    case 'amountRouting':
      return {
        ...node,
        lower: compositeIsmNodeArtifactToConfig(node.lower, chainLookup),
        upper: compositeIsmNodeArtifactToConfig(node.upper, chainLookup),
      };
    case 'routing':
    case 'fallbackRouting': {
      if (!node.domains) {
        return { ...node, domains: undefined };
      }
      const domains: Record<string, CompositeIsmNodeConfig> = {};
      for (const [domainIdStr, domainNode] of Object.entries(node.domains)) {
        const chainName = chainLookup.getChainName(parseInt(domainIdStr));
        if (!chainName) {
          // Skip unknown domains, matching domainRoutingIsm's behavior
          continue;
        }
        domains[chainName] = compositeIsmNodeArtifactToConfig(
          domainNode,
          chainLookup,
        );
      }
      return { ...node, domains };
    }
    default:
      return node;
  }
}

/**
 * Recursively converts a composite ISM node from the Config API shape
 * (chain-name-keyed `domains`) to the Artifact API shape (domain-ID-keyed).
 * Inverse of {@link compositeIsmNodeArtifactToConfig}.
 */
function compositeIsmNodeConfigToArtifact(
  node: CompositeIsmNodeConfig,
  chainLookup: ChainLookup,
): CompositeIsmNodeArtifactConfig {
  switch (node.type) {
    case 'aggregation':
      return {
        ...node,
        subIsms: node.subIsms.map((sub) =>
          compositeIsmNodeConfigToArtifact(sub, chainLookup),
        ),
      };
    case 'amountRouting':
      return {
        ...node,
        lower: compositeIsmNodeConfigToArtifact(node.lower, chainLookup),
        upper: compositeIsmNodeConfigToArtifact(node.upper, chainLookup),
      };
    case 'routing':
    case 'fallbackRouting': {
      if (!node.domains) {
        return { ...node, domains: undefined };
      }
      const domains: Record<number, CompositeIsmNodeArtifactConfig> = {};
      for (const [chainName, domainNode] of Object.entries(node.domains)) {
        const domainId = chainLookup.getDomainId(chainName);
        if (isNullish(domainId)) {
          // Skip unknown chains, matching domainRoutingIsm's behavior
          continue;
        }
        domains[domainId] = compositeIsmNodeConfigToArtifact(
          domainNode,
          chainLookup,
        );
      }
      return { ...node, domains };
    }
    default:
      return node;
  }
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

    case 'compositeIsm':
      return {
        type: 'compositeIsm',
        owner: config.owner,
        root: compositeIsmNodeArtifactToConfig(config.root, chainLookup),
        address,
      };

    default: {
      return assertNever(config, 'ismArtifactToDerivedConfig');
    }
  }
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
 * // Config API format
 * const ismConfig: IsmConfig = {
 *   type: 'domainRoutingIsm',
 *   owner: '0x123...',
 *   domains: {
 *     ethereum: { type: 'merkleRootMultisigIsm', validators: [...], threshold: 2 },
 *     polygon: '0xabc...' // address reference
 *   }
 * };
 *
 * // Convert to Artifact API format
 * const artifact = ismConfigToArtifact(ismConfig, chainLookup);
 * // artifact.config.domains is now Record<number, Artifact<IsmArtifactConfig>>
 * // with numeric domain IDs and properly wrapped nested configs
 * ```
 */
export function ismConfigToArtifact(
  config: IsmConfig,
  chainLookup: ChainLookup,
): ArtifactNew<IsmArtifactConfig> {
  // Handle routing ISMs - need to convert chain names to domain IDs
  if (config.type === 'domainRoutingIsm') {
    const domains: Record<
      number,
      Artifact<IsmArtifactConfig, DeployedIsmAddress>
    > = {};

    for (const [chainName, nestedConfig] of Object.entries(config.domains)) {
      const domainId = chainLookup.getDomainId(chainName);
      if (isNullish(domainId)) {
        // Skip unknown chains - they'll be warned about during deployment
        continue;
      }

      if (typeof nestedConfig === 'string') {
        // Address reference - create an UNDERIVED artifact
        // This represents a predeployed ISM with unspecified type
        // The routing ISM writer will pass it through without reading
        // Only readers will fetch its config from chain if needed
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

  // Composite ISM - need to convert chain names to domain IDs throughout the tree
  if (config.type === 'compositeIsm') {
    return {
      artifactState: ArtifactState.NEW,
      config: {
        type: 'compositeIsm',
        owner: config.owner,
        root: compositeIsmNodeConfigToArtifact(config.root, chainLookup),
      },
    };
  }

  // Other ISM types (multisig, testIsm) have identical config structure
  // between Config API and Artifact API - just wrap in artifact object
  return { artifactState: ArtifactState.NEW, config };
}
