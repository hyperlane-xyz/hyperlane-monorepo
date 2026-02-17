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
import { type AleoNetworkId } from '../utils/types.js';

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
export class AleoValidatorAnnounceArtifactManager
  implements IRawValidatorAnnounceArtifactManager
{
  constructor(
    private readonly aleoNetworkId: AleoNetworkId,
    private readonly aleoClient: AnyAleoNetworkClient,
  ) {}

  async readValidatorAnnounce(address: string) {
    const reader = this.createReader('validatorAnnounce');
    return reader.read(address);
  }

  createReader<T extends ValidatorAnnounceType>(
    _type: T,
  ): ArtifactReader<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    return new AleoValidatorAnnounceReader(this.aleoClient);
  }

  createWriter<T extends ValidatorAnnounceType>(
    _type: T,
    signer: AleoSigner,
  ): ArtifactWriter<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    return new AleoValidatorAnnounceWriter(
      this.aleoNetworkId,
      this.aleoClient,
      signer,
    );
  }
}
