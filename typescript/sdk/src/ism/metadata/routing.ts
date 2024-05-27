import { WithAddress, assert } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types.js';
import { DerivedIsmConfig } from '../EvmIsmReader.js';
import { IsmType, RoutingIsmConfig } from '../types.js';

import {
  BaseMetadataBuilder,
  MetadataBuilder,
  MetadataContext,
  StructuredMetadata,
} from './builder.js';

export type RoutingMetadata<T> = {
  type: IsmType.ROUTING;
  origin: ChainName;
  metadata: T;
};

export class RoutingMetadataBuilder implements MetadataBuilder {
  constructor(protected baseMetadataBuilder: BaseMetadataBuilder) {}

  public async build(
    context: MetadataContext<WithAddress<RoutingIsmConfig>>,
    maxDepth = 10,
  ): Promise<string> {
    const originChain = this.baseMetadataBuilder.multiProvider.getChainName(
      context.message.parsed.origin,
    );
    const originContext = {
      ...context,
      ism: context.ism.domains[originChain] as DerivedIsmConfig,
    };
    return this.baseMetadataBuilder.build(originContext, maxDepth - 1);
  }

  static decode(
    metadata: string,
    context: MetadataContext<WithAddress<RoutingIsmConfig>>,
  ): RoutingMetadata<StructuredMetadata | string> {
    // TODO: this is a naive implementation, we should support domain ID keys
    assert(context.message.parsed.originChain, 'originChain is required');
    const ism = context.ism.domains[context.message.parsed.originChain];
    const originMetadata =
      typeof ism === 'string'
        ? metadata
        : BaseMetadataBuilder.decode(metadata, {
            ...context,
            ism: ism as DerivedIsmConfig,
          });

    return {
      type: IsmType.ROUTING,
      origin: context.message.parsed.originChain,
      metadata: originMetadata,
    };
  }
}
