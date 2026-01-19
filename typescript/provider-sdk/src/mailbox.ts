import {
  Artifact,
  ArtifactDeployed,
  IArtifactManager,
  RawArtifact,
} from './artifact.js';
import type { DeployedHookAddress, HookArtifactConfig } from './hook.js';
import type { DeployedIsmAddress, IsmArtifactConfig } from './ism.js';

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
