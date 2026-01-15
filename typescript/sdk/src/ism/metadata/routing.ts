import {
  DefaultFallbackRoutingIsm__factory,
  IRoutingIsm__factory,
} from '@hyperlane-xyz/core';
import { WithAddress, assert } from '@hyperlane-xyz/utils';

import { ChainName } from '../../types.js';
import { EvmIsmReader } from '../EvmIsmReader.js';
import {
  DerivedIsmConfig,
  DomainRoutingIsmConfig,
  IsmType,
  RoutingIsmConfig,
  isDynamicallyRoutedIsmType,
} from '../types.js';

import type { BaseMetadataBuilder } from './builder.js';
import { decodeIsmMetadata } from './decode.js';
import type {
  MetadataBuilder,
  MetadataContext,
  RoutingMetadataBuildResult,
  StructuredMetadata,
} from './types.js';

export type RoutingMetadata<T> = {
  type: typeof IsmType.ROUTING;
  origin: ChainName;
  metadata: T;
};

export class StaticRoutingMetadataBuilder implements MetadataBuilder {
  constructor(protected baseMetadataBuilder: BaseMetadataBuilder) {}

  public async build(
    context: MetadataContext<WithAddress<DomainRoutingIsmConfig>>,
    maxDepth = 10,
  ): Promise<RoutingMetadataBuildResult> {
    const originChain = this.baseMetadataBuilder.multiProvider.getChainName(
      context.message.parsed.origin,
    );
    const originContext = {
      ...context,
      ism: context.ism.domains[originChain] as DerivedIsmConfig,
    };

    const selectedIsmResult = await this.baseMetadataBuilder.build(
      originContext,
      maxDepth - 1,
    );

    return {
      type: context.ism.type,
      ismAddress: context.ism.address,
      originChain,
      selectedIsm: selectedIsmResult,
      // Propagate metadata from selected ISM
      metadata: selectedIsmResult.metadata,
    };
  }

  static decode(
    metadata: string,
    context: MetadataContext<WithAddress<DomainRoutingIsmConfig>>,
  ): RoutingMetadata<StructuredMetadata | string> {
    // TODO: this is a naive implementation, we should support domain ID keys
    assert(context.message.parsed.originChain, 'originChain is required');
    const ism = context.ism.domains[context.message.parsed.originChain];

    const originMetadata =
      typeof ism === 'string'
        ? metadata
        : decodeIsmMetadata(metadata, {
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

export class DynamicRoutingMetadataBuilder extends StaticRoutingMetadataBuilder {
  constructor(protected baseMetadataBuilder: BaseMetadataBuilder) {
    super(baseMetadataBuilder);
  }

  public async build(
    context: MetadataContext<WithAddress<RoutingIsmConfig>>,
    maxDepth = 10,
  ): Promise<RoutingMetadataBuildResult> {
    const { message, ism } = context;
    const originChain = this.baseMetadataBuilder.multiProvider.getChainName(
      message.parsed.origin,
    );
    const destination = message.parsed.destination;
    const provider =
      this.baseMetadataBuilder.multiProvider.getProvider(destination);

    // Helper to derive new ISM config and recurse
    const deriveAndRecurse = async (
      moduleAddress: string,
    ): Promise<RoutingMetadataBuildResult> => {
      const ismReader = new EvmIsmReader(
        this.baseMetadataBuilder.multiProvider,
        destination,
      );
      const nextConfig = await ismReader.deriveIsmConfig(moduleAddress);
      const selectedIsmResult = await this.baseMetadataBuilder.build(
        { ...context, ism: nextConfig },
        maxDepth - 1,
      );

      return {
        type: ism.type,
        ismAddress: ism.address,
        originChain,
        selectedIsm: selectedIsmResult,
        metadata: selectedIsmResult.metadata,
      };
    };

    // 1) Dynamic routing (AmountRouting or ICA): always route via .route(message)
    if (isDynamicallyRoutedIsmType(ism.type)) {
      const router = IRoutingIsm__factory.connect(ism.address, provider);
      const moduleAddr = await router.route(message.message);
      return deriveAndRecurse(moduleAddr);
    }

    // 2) Static domain routing: if origin is enrolled, delegate to super
    if ((ism as DomainRoutingIsmConfig).domains?.[originChain]) {
      return super.build(
        context as MetadataContext<WithAddress<DomainRoutingIsmConfig>>,
        maxDepth,
      );
    }

    // 3) Fallback routing: use .module(origin)
    if (ism.type === IsmType.FALLBACK_ROUTING) {
      const fallback = DefaultFallbackRoutingIsm__factory.connect(
        ism.address,
        provider,
      );
      const moduleAddr = await fallback.module(message.parsed.origin);
      return deriveAndRecurse(moduleAddr);
    }

    throw new Error(
      `DefaultFallbackRoutingMetadataBuilder: unexpected ISM type ${ism.type}`,
    );
  }
}
