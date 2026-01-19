import { ArtifactDeployed, IArtifactManager } from './artifact.js';

// Artifact API types

/**
 * Validator Announce configuration for the Artifact API.
 * Defines the parameters needed to deploy or configure a validator announce contract.
 */
export interface ValidatorAnnounceConfig {
  mailboxAddress: string; // Reference to the mailbox contract address
}

/**
 * Deployment data returned after deploying a validator announce contract.
 * Contains the on-chain address.
 */
export interface DeployedValidatorAnnounceAddress {
  address: string;
}

/**
 * Describes the configuration of a deployed validator announce contract
 */
export type DeployedValidatorAnnounceArtifact = ArtifactDeployed<
  ValidatorAnnounceConfig,
  DeployedValidatorAnnounceAddress
>;

/**
 * Validator announce artifact config type (single type for now, but supports future variants)
 */
export type ValidatorAnnounceArtifactConfig = ValidatorAnnounceConfig;

/**
 * Validator announce artifact configs map (supports future validator announce variants)
 */
export interface ValidatorAnnounceArtifactConfigs {
  validatorAnnounce: ValidatorAnnounceConfig;
}

export type ValidatorAnnounceType = keyof ValidatorAnnounceArtifactConfigs;

/**
 * Should be used to implement an object/closure or class that is in charge of coordinating
 * deployment of a ValidatorAnnounce config.
 */
export type IValidatorAnnounceArtifactManager = IArtifactManager<
  ValidatorAnnounceType,
  ValidatorAnnounceArtifactConfigs,
  DeployedValidatorAnnounceAddress
>;

/**
 * Raw validator announce config - identical to the compound config since there are no nested artifacts.
 * Kept for consistency with the artifact API pattern.
 */
export interface RawValidatorAnnounceConfig {
  mailboxAddress: string;
}

/**
 * Raw validator announce artifact configs map
 */
export interface RawValidatorAnnounceArtifactConfigs {
  validatorAnnounce: RawValidatorAnnounceConfig;
}

/**
 * Should be used for the specific artifact code that
 * deploys or reads a single validator announce artifact on chain
 */
export type RawValidatorAnnounceArtifactConfig =
  RawValidatorAnnounceArtifactConfigs[ValidatorAnnounceType];

/**
 * Describes the configuration of deployed validator announce without nested config expansion
 */
export type DeployedRawValidatorAnnounceArtifact = ArtifactDeployed<
  RawValidatorAnnounceArtifactConfig,
  DeployedValidatorAnnounceAddress
>;

/**
 * Should be used to implement an object/closure or class that individually deploys
 * ValidatorAnnounce contracts on chain
 */
export interface IRawValidatorAnnounceArtifactManager
  extends IArtifactManager<
    ValidatorAnnounceType,
    RawValidatorAnnounceArtifactConfigs,
    DeployedValidatorAnnounceAddress
  > {
  /**
   * Read a validator announce contract by its address.
   * This is the entry point for reading validator announce configuration from the chain.
   * @param address The on-chain address of the validator announce contract
   * @returns The artifact configuration and deployment data
   */
  readValidatorAnnounce(
    address: string,
  ): Promise<DeployedRawValidatorAnnounceArtifact>;
}
