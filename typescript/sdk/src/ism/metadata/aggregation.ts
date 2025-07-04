import {
  WithAddress,
  assert,
  fromHexString,
  rootLogger,
  timeout,
  toHexString,
} from '@hyperlane-xyz/utils';

import { AggregationIsmConfig, DerivedIsmConfig, IsmType } from '../types.js';

import type { BaseMetadataBuilder } from './builder.js';
import { decodeIsmMetadata } from './decode.js';
import {
  MetadataBuilder,
  MetadataContext,
  StructuredMetadata,
} from './types.js';

// null indicates that metadata is NOT INCLUDED for this submodule
// empty or 0x string indicates that metadata is INCLUDED but NULL
export interface AggregationMetadata<T = string> {
  type: AggregationIsmConfig['type'];
  submoduleMetadata: Array<T | null>;
}

const RANGE_SIZE = 4;

// adapted from rust/main/agents/relayer/src/msg/metadata/aggregation.rs
export class AggregationMetadataBuilder implements MetadataBuilder {
  protected logger = rootLogger.child({
    module: 'AggregationIsmMetadataBuilder',
  });

  constructor(protected readonly base: BaseMetadataBuilder) {}

  async build(
    context: MetadataContext<WithAddress<AggregationIsmConfig>>,
    maxDepth = 10,
    timeoutMs = maxDepth * 1000,
  ): Promise<string> {
    this.logger.debug(
      { context, maxDepth, timeoutMs },
      'Building aggregation metadata',
    );
    assert(maxDepth > 0, 'Max depth reached');
    const results = await Promise.allSettled(
      context.ism.modules.map((module) =>
        timeout(
          this.base.build(
            {
              ...context,
              ism: module as DerivedIsmConfig,
            },
            maxDepth - 1,
          ),
          timeoutMs,
        ),
      ),
    );

    const metadatas = results.map((result, index) => {
      if (result.status === 'rejected') {
        this.logger.warn(
          `Failed to build for submodule ${index}: ${result.reason}`,
        );
        return null;
      } else {
        this.logger.debug(`Built metadata for submodule ${index}`);
        return result.value;
      }
    });

    const included = metadatas.filter((meta) => meta !== null).length;
    assert(
      included >= context.ism.threshold,
      `Only built ${included} of ${context.ism.threshold} required modules`,
    );

    // only include the first threshold metadatas
    let count = 0;
    for (let i = 0; i < metadatas.length; i++) {
      if (metadatas[i] === null) continue;
      count += 1;
      if (count > context.ism.threshold) metadatas[i] = null;
    }

    return AggregationMetadataBuilder.encode({
      ...context.ism,
      submoduleMetadata: metadatas,
    });
  }

  static rangeIndex(index: number): number {
    return index * 2 * RANGE_SIZE;
  }

  static encode(metadata: AggregationMetadata<string>): string {
    const rangeSize = this.rangeIndex(metadata.submoduleMetadata.length);

    let encoded = Buffer.alloc(rangeSize, 0);
    metadata.submoduleMetadata.forEach((meta, index) => {
      if (!meta) return;

      const start = encoded.length;
      encoded = Buffer.concat([encoded, fromHexString(meta)]);
      const end = encoded.length;

      const rangeStart = this.rangeIndex(index);
      encoded.writeUint32BE(start, rangeStart);
      encoded.writeUint32BE(end, rangeStart + RANGE_SIZE);
    });

    return toHexString(encoded);
  }

  static metadataRange(
    metadata: string,
    index: number,
  ): { start: number; end: number; encoded: string } {
    const rangeStart = this.rangeIndex(index);
    const encoded = fromHexString(metadata);
    const start = encoded.readUint32BE(rangeStart);
    const end = encoded.readUint32BE(rangeStart + RANGE_SIZE);
    return {
      start,
      end,
      encoded: toHexString(encoded.subarray(start, end)),
    };
  }

  static decode(
    metadata: string,
    context: MetadataContext<AggregationIsmConfig>,
  ): AggregationMetadata<StructuredMetadata | string> {
    const submoduleMetadata = context.ism.modules.map((ism, index) => {
      const range = this.metadataRange(metadata, index);
      if (range.start == 0) return null;
      if (typeof ism === 'string') return range.encoded;
      return decodeIsmMetadata(range.encoded, {
        ...context,
        ism: ism as DerivedIsmConfig,
      });
    });
    return { type: IsmType.AGGREGATION, submoduleMetadata };
  }
}
