import { ParsedMessage, WithAddress, assert } from '@hyperlane-xyz/utils';

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
    depth = 10,
  ): Promise<string> {
    const originChain = this.baseMetadataBuilder.multiProvider.getChainName(
      context.message.parsed.origin,
    );
    const originContext = {
      ...context,
      ism: context.ism.domains[originChain] as DerivedIsmConfig,
    };
    return this.baseMetadataBuilder.build(originContext, depth - 1);
  }

  static decode(
    metadata: string,
    message: ParsedMessage,
    ism: RoutingIsmConfig,
  ): RoutingMetadata<StructuredMetadata | string> {
    assert(message.originChain, 'originChain is required');
    const originModule = ism.domains[message.originChain];
    const originMetadata =
      typeof originModule === 'string'
        ? metadata
        : BaseMetadataBuilder.decode(metadata, message, originModule);
    return {
      type: IsmType.ROUTING,
      origin: message.originChain,
      metadata: originMetadata,
    };
  }
}
