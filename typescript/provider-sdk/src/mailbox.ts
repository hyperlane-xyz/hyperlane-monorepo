import {
  Artifact,
  ArtifactDeployed,
  IArtifactManager,
  RawArtifact,
  isArtifactDeployed,
} from './artifact.js';
import type { ChainLookup } from './chain.js';
import type {
  DeployedHookAddress,
  DerivedHookConfig,
  HookArtifactConfig,
} from './hook.js';
import type {
  DeployedIsmAddress,
  DerivedIsmConfig,
  IsmArtifactConfig,
} from './ism.js';

// Artifact API types

/**
 * Mailbox configuration for the Artifact API.
 * Defines the parameters needed to deploy or configure a mailbox.
 */
export interface MailboxConfig {
  owner: string;
  defaultIsm: Artifact<IsmArtifactConfig, DeployedIsmAddress>; // ISM artifact reference
  defaultHook: Artifact<HookArtifactConfig, DeployedHookAddress>; // Hook artifact reference
  requiredHook: Artifact<HookArtifactConfig, DeployedHookAddress>; // Hook artifact reference
}

/**
 * Deployment data returned after deploying a mailbox.
 * Contains the on-chain address and optionally the domain ID.
 */
export interface DeployedMailboxAddress {
  address: string;
  domainId?: number;
}

/**
 * Describes the configuration of a deployed mailbox
 */
export type DeployedMailboxArtifact = ArtifactDeployed<
  MailboxConfig,
  DeployedMailboxAddress
>;

/**
 * Mailbox artifact config type (single type for now, but supports future variants)
 */
export type MailboxArtifactConfig = MailboxConfig;

/**
 * Mailbox artifact configs map (supports future mailbox variants)
 */
export interface MailboxArtifactConfigs {
  mailbox: MailboxConfig;
}

export type MailboxType = keyof MailboxArtifactConfigs;

/**
 * Should be used to implement an object/closure or class that is in charge of coordinating
 * deployment of a Mailbox config, including nested ISM and Hook deployments.
 */
export type IMailboxArtifactManager = IArtifactManager<
  MailboxType,
  MailboxArtifactConfigs,
  DeployedMailboxAddress
>;

/**
 * Raw mailbox config - uses ArtifactOnChain for nested artifacts instead of Artifact.
 * This is the format used by protocol implementations that work directly with on-chain state.
 */
export type RawMailboxConfig = RawArtifact<
  MailboxConfig,
  DeployedMailboxAddress
>;

/**
 * Raw mailbox artifact configs map
 */
export interface RawMailboxArtifactConfigs {
  mailbox: RawMailboxConfig;
}

/**
 * Should be used for the specific artifact code that
 * deploys or reads a single mailbox artifact on chain
 */
export type RawMailboxArtifactConfig = RawMailboxArtifactConfigs[MailboxType];

/**
 * Describes the configuration of deployed mailbox without nested config expansion
 */
export type DeployedRawMailboxArtifact = ArtifactDeployed<
  RawMailboxArtifactConfig,
  DeployedMailboxAddress
>;

/**
 * Should be used to implement an object/closure or class that individually deploys
 * Mailboxes on chain
 */
export interface IRawMailboxArtifactManager
  extends IArtifactManager<
    MailboxType,
    RawMailboxArtifactConfigs,
    DeployedMailboxAddress
  > {
  /**
   * Read a mailbox by its address.
   * This is the entry point for reading mailbox configuration from the chain.
   * @param address The on-chain address of the mailbox
   * @returns The artifact configuration and deployment data
   */
  readMailbox(address: string): Promise<DeployedRawMailboxArtifact>;
}

/**
 * Converts a DeployedMailboxArtifact (with fully expanded nested ISM/hook artifacts)
 * to the DerivedCoreConfig format for backward compatibility.
 *
 * This function is used by CoreArtifactReader to provide the deriveCoreConfig() method
 * that existing code expects. The conversion functions for ISM and Hook artifacts
 * must be passed in to avoid circular dependencies.
 *
 * @param artifact The deployed mailbox artifact with expanded nested configs
 * @param chainLookup Chain lookup for converting domain IDs to chain names
 * @param converters Object containing ismArtifactToDerivedConfig and hookArtifactToDerivedConfig functions
 * @returns DerivedCoreConfig in the legacy format (from core.ts)
 */
export function mailboxArtifactToDerivedCoreConfig(
  artifact: DeployedMailboxArtifact,
  chainLookup: ChainLookup,
  converters: {
    ismArtifactToDerivedConfig: (
      artifact: any,
      chainLookup: ChainLookup,
    ) => DerivedIsmConfig;
    hookArtifactToDerivedConfig: (
      artifact: any,
      chainLookup: ChainLookup,
    ) => DerivedHookConfig;
  },
): {
  owner: string;
  defaultIsm: DerivedIsmConfig;
  defaultHook: DerivedHookConfig;
  requiredHook: DerivedHookConfig;
} {
  const { defaultIsm, defaultHook, requiredHook, owner } = artifact.config;

  // All nested artifacts should be in DEPLOYED state after CoreArtifactReader.read()
  if (!isArtifactDeployed(defaultIsm)) {
    throw new Error(
      'Expected defaultIsm to be DEPLOYED, got ' + defaultIsm.artifactState,
    );
  }
  if (!isArtifactDeployed(defaultHook)) {
    throw new Error(
      'Expected defaultHook to be DEPLOYED, got ' + defaultHook.artifactState,
    );
  }
  if (!isArtifactDeployed(requiredHook)) {
    throw new Error(
      'Expected requiredHook to be DEPLOYED, got ' + requiredHook.artifactState,
    );
  }

  return {
    owner,
    defaultIsm: converters.ismArtifactToDerivedConfig(defaultIsm, chainLookup),
    defaultHook: converters.hookArtifactToDerivedConfig(
      defaultHook,
      chainLookup,
    ),
    requiredHook: converters.hookArtifactToDerivedConfig(
      requiredHook,
      chainLookup,
    ),
  };
}
