import { IsmArtifact, TestIsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  ArtifactReader,
  ArtifactWriter,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';

import { RadixBase } from '../utils/base.js';
import { RadixBaseSigner } from '../utils/signer.js';

import { RadixCorePopulate } from './populate.js';
import { RadixCoreQuery } from './query.js';

export class TestIsmArtifactReader
  implements ArtifactReader<IsmArtifact<'testIsm'>>
{
  constructor(private query: RadixCoreQuery) {}

  async read(address: string): Promise<TestIsmConfig> {
    // Verify it's a NoopIsm (TestIsm on Radix)
    const ismType = await this.query.getIsmType({ ism: address });

    if (ismType !== 'NoopIsm') {
      throw new Error(
        `Expected NoopIsm (TestIsm) at address ${address}, but found ${ismType}`,
      );
    }

    return {
      type: 'testIsm',
    };
  }
}

export class TestIsmArtifactWriter
  implements ArtifactWriter<IsmArtifact<'testIsm'>>
{
  constructor(
    private account: string,
    private populate: RadixCorePopulate,
    private signer: RadixBaseSigner,
    private base: RadixBase,
  ) {}

  async create(
    _config: TestIsmConfig,
  ): Promise<[{ deployedIsm: string }, TxReceipt[]]> {
    const manifest = await this.populate.createNoopIsm({
      from_address: this.account,
    });

    const receipt = await this.signer.signAndBroadcast(manifest);
    const ismAddress = await this.base.getNewComponent(receipt);

    return [{ deployedIsm: ismAddress }, [receipt]];
  }

  async update(
    _address: string,
    _config: TestIsmConfig,
  ): Promise<AnnotatedTx[]> {
    // TestIsm (NoopIsm) is immutable - no updates possible
    return [];
  }
}
