import { WithAddress, assert, eqAddress } from '@hyperlane-xyz/utils';

import { MultiProvider } from '../../providers/MultiProvider.js';
import { IsmType, NullIsmConfig } from '../types.js';

import { MetadataBuilder, MetadataContext } from './builder.js';

export type NullMetadata = {
  type: NullIsmConfig['type'];
};

export class NullMetadataBuilder implements MetadataBuilder {
  constructor(protected multiProvider: MultiProvider) {}

  async build(
    context: MetadataContext<WithAddress<NullIsmConfig>>,
  ): Promise<string> {
    if (context.ism.type === IsmType.TRUSTED_RELAYER) {
      const destinationSigner = await this.multiProvider.getSignerAddress(
        context.message.parsed.destination,
      );
      assert(
        eqAddress(destinationSigner, context.ism.relayer),
        `Destination signer ${destinationSigner} does not match trusted relayer ${context.ism.relayer}`,
      );
    }
    return '0x';
  }

  static decode(ism: NullIsmConfig): NullMetadata {
    return { ...ism };
  }
}
