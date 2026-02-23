import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedValidatorAnnounceAddress,
  IRawValidatorAnnounceArtifactManager,
  RawValidatorAnnounceArtifactConfigs,
  ValidatorAnnounceType,
} from '@hyperlane-xyz/provider-sdk/validator-announce';

import { RadixSigner } from '../clients/signer.js';
import { RadixBase } from '../utils/base.js';

import { RadixValidatorAnnounceReader } from './validator-announce-reader.js';
import { RadixValidatorAnnounceWriter } from './validator-announce-writer.js';

export class RadixValidatorAnnounceArtifactManager
  implements IRawValidatorAnnounceArtifactManager
{
  constructor(
    private readonly gateway: GatewayApiClient,
    private readonly base: RadixBase,
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
    const readers: {
      [K in ValidatorAnnounceType]: () => ArtifactReader<
        RawValidatorAnnounceArtifactConfigs[K],
        DeployedValidatorAnnounceAddress
      >;
    } = {
      validatorAnnounce: () => new RadixValidatorAnnounceReader(this.gateway),
    };

    return readers[_type]();
  }

  createWriter<T extends ValidatorAnnounceType>(
    _type: T,
    signer: RadixSigner,
  ): ArtifactWriter<
    RawValidatorAnnounceArtifactConfigs[T],
    DeployedValidatorAnnounceAddress
  > {
    const baseSigner = signer.getBaseSigner();
    const writers: {
      [K in ValidatorAnnounceType]: () => ArtifactWriter<
        RawValidatorAnnounceArtifactConfigs[K],
        DeployedValidatorAnnounceAddress
      >;
    } = {
      validatorAnnounce: () =>
        new RadixValidatorAnnounceWriter(this.gateway, baseSigner, this.base),
    };

    return writers[_type]();
  }
}
