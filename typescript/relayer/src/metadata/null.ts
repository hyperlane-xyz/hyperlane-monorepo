import {
  IsmType,
  LayerZeroV2IsmConfig,
  MultiProvider,
  NullIsmConfig,
  WormholeIsmConfig,
} from '@hyperlane-xyz/sdk';
import { WithAddress, assert, eqAddress } from '@hyperlane-xyz/utils';

import type {
  MetadataBuilder,
  MetadataContext,
  NullMetadataBuildResult,
} from './types.js';

export const NULL_METADATA = '0x';

export type NullMetadata = {
  type:
    | NullIsmConfig['type']
    | typeof IsmType.WORMHOLE_EXECUTOR
    | typeof IsmType.LAYER_ZERO_V2_CALLBACK;
};

/** ISM configs whose metadata is always empty. */
export type EmptyMetadataIsmConfig =
  | NullIsmConfig
  | (WormholeIsmConfig & { type: typeof IsmType.WORMHOLE_EXECUTOR })
  | Extract<
      LayerZeroV2IsmConfig,
      { type: typeof IsmType.LAYER_ZERO_V2_CALLBACK }
    >;

export class NullMetadataBuilder implements MetadataBuilder {
  constructor(protected multiProvider: MultiProvider) {}

  async build(
    context: MetadataContext<WithAddress<EmptyMetadataIsmConfig>>,
  ): Promise<NullMetadataBuildResult> {
    if (context.ism.type === IsmType.TRUSTED_RELAYER) {
      const destinationSigner = await this.multiProvider.getSignerAddress(
        context.message.parsed.destination,
      );
      assert(
        eqAddress(destinationSigner, context.ism.relayer),
        `Destination signer ${destinationSigner} does not match trusted relayer ${context.ism.relayer}`,
      );
    }

    return {
      type: context.ism.type,
      ismAddress: context.ism.address,
      metadata: NULL_METADATA,
    };
  }

  static decode(ism: EmptyMetadataIsmConfig): NullMetadata {
    return { ...ism };
  }
}
