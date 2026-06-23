import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedValidatorAnnounceAddress,
  type IRawValidatorAnnounceArtifactManager,
  type RawValidatorAnnounceArtifactConfigs,
  type ValidatorAnnounceType,
} from '@hyperlane-xyz/provider-sdk/validator-announce';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';
import { type AleoArtifactNetworkConfig } from '../utils/types.js';

import {
  AleoValidatorAnnounceReader,
  AleoValidatorAnnounceWriter,
} from './validator-announce.js';

/**
 * Aleo ValidatorAnnounce Artifact Manager implementing IRawValidatorAnnounceArtifactManager.
 *
 * This manager:
 * - Provides factory methods for creating validator announce readers and writers
 * - Handles validator announce deployment
 */
export class AleoValidatorAnnounceArtifactManager implements IRawValidatorAnnounceArtifactManager {
  constructor(
    private readonly config: AleoArtifactNetworkConfig,
    private readonly aleoClient: AnyAleoNetworkClient,
  ) {}

  async readValidatorAnnounce(address: string) {
    const reader = this.createReader('validatorAnnounce');
    return reader.read(address);
  }

  createReader<T extends ValidatorAnnounceType>(
    type: T,
  ): ArtifactReader<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    const readers: {
      [K in ValidatorAnnounceType]: () => ArtifactReader<
        RawValidatorAnnounceArtifactConfigs[K],
        DeployedValidatorAnnounceAddress
      >;
    } = {
      validatorAnnounce: () => new AleoValidatorAnnounceReader(this.aleoClient),
    };
    return readers[type]();
  }

  createWriter<T extends ValidatorAnnounceType>(
    type: T,
    signer: AleoSigner,
  ): ArtifactWriter<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    const writers: {
      [K in ValidatorAnnounceType]: () => ArtifactWriter<
        RawValidatorAnnounceArtifactConfigs[K],
        DeployedValidatorAnnounceAddress
      >;
    } = {
      validatorAnnounce: () =>
        new AleoValidatorAnnounceWriter(this.config, this.aleoClient, signer),
    };
    return writers[type]();
  }
}
