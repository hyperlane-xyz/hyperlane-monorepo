import {
  DerivedIsm,
  IsmArtifact,
  RawIsmArtifactReader,
  RawIsmArtifactWriter,
  TestIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  ArtifactDeployed,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';

import { RadixCorePopulate } from './populate.js';
import { RadixCoreQuery } from './query.js';

export class TestIsmArtifactReader implements RawIsmArtifactReader<'testIsm'> {
  constructor(private query: RadixCoreQuery) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<TestIsmConfig, DerivedIsm>> {
    // Verify it's a NoopIsm (TestIsm on Radix)
    const ismType = await this.query.getIsmType({ ism: address });

    if (ismType !== 'NoopIsm') {
      throw new Error(
        `Expected NoopIsm (TestIsm) at address ${address}, but found ${ismType}`,
      );
    }

    return {
      artifactState: 'deployed',
      config: {
        type: 'testIsm',
      },
      deployed: {
        address,
      },
    };
  }
}

export class TestIsmArtifactWriter implements RawIsmArtifactWriter<'testIsm'> {
  constructor(
    private account: string,
    private populate: RadixCorePopulate,
    private signer: RadixBaseSigner,
    private base: RadixBase,
  ) {}

  async create(
    artifact: IsmArtifact<'testIsm'>,
  ): Promise<[ArtifactDeployed<TestIsmConfig, DerivedIsm>, TxReceipt[]]> {
    const manifest = await this.populate.createNoopIsm({
      from_address: this.account,
    });

    const receipt = await this.signer.signAndBroadcast(manifest);
    const ismAddress = await this.base.getNewComponent(receipt);

    return [
      {
        artifactState: 'deployed',
        config: artifact.config,
        deployed: {
          address: ismAddress,
        },
      },
      [receipt],
    ];
  }

  async update(
    _address: string,
    _artifact: ArtifactDeployed<TestIsmConfig, DerivedIsm>,
  ): Promise<AnnotatedTx[]> {
    // TestIsm (NoopIsm) is immutable - no updates possible
    return [];
  }
}
