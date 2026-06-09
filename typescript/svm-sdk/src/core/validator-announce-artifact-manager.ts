import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedRawValidatorAnnounceArtifact,
  DeployedValidatorAnnounceAddress,
  IRawValidatorAnnounceArtifactManager,
  RawValidatorAnnounceArtifactConfigs,
  ValidatorAnnounceType,
} from '@hyperlane-xyz/provider-sdk/validator-announce';

import type { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import type { SvmRpc } from '../types.js';

import {
  SvmValidatorAnnounceReader,
  SvmValidatorAnnounceWriter,
} from './validator-announce.js';

export class SvmValidatorAnnounceArtifactManager implements IRawValidatorAnnounceArtifactManager {
  constructor(
    private readonly rpc: SvmRpc,
    private readonly domainId: number,
  ) {}

  async readValidatorAnnounce(
    address: string,
  ): Promise<DeployedRawValidatorAnnounceArtifact> {
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
      validatorAnnounce: () => new SvmValidatorAnnounceReader(this.rpc),
    };

    return readers[type]();
  }

  createWriter<T extends ValidatorAnnounceType>(
    type: T,
    signer: SvmSigner,
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
        new SvmValidatorAnnounceWriter(
          {
            program: {
              programBytes: HYPERLANE_SVM_PROGRAM_BYTES.validatorAnnounce,
            },
            domainId: this.domainId,
          },
          this.rpc,
          signer,
        ),
    };

    return writers[type]();
  }
}
