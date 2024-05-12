import { WithAddress, assert, eqAddress } from '@hyperlane-xyz/utils';

import { DispatchedMessage } from '../../core/types.js';
import { DerivedHookConfigWithAddress } from '../../hook/EvmHookReader.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { NullIsmConfig } from '../EvmIsmReader.js';
import { IsmType } from '../types.js';

import { MetadataBuilder } from './builder.js';

type DerivedNullIsmConfig = WithAddress<NullIsmConfig>;

export type NullIsmMetadata = {
  type: NullIsmConfig['type'];
};

export class NullMetadataBuilder
  implements
    MetadataBuilder<DerivedNullIsmConfig, DerivedHookConfigWithAddress>
{
  constructor(protected multiProvider: MultiProvider) {}

  async build(
    message: DispatchedMessage,
    context: {
      ism: DerivedNullIsmConfig;
    },
  ): Promise<string> {
    if (context.ism.type === IsmType.TRUSTED_RELAYER) {
      const destinationSigner = await this.multiProvider.getSignerAddress(
        message.parsed.destination,
      );
      assert(
        eqAddress(destinationSigner, context.ism.relayer),
        `Destination signer ${destinationSigner} does not match trusted relayer ${context.ism.relayer}`,
      );
    }
    return '0x';
  }
}
