import {
  WithAddress,
  fromHexString,
  rootLogger,
  timeout,
  toHexString,
} from '@hyperlane-xyz/utils';

import { AggregationIsmConfig, DerivedIsmConfig, IsmType } from '../types.js';

import type { BaseMetadataBuilder } from './builder.js';
import { decodeIsmMetadata } from './decode.js';
import {
  AggregationMetadataBuildResult,
  MetadataBuildResult,
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
  ): Promise<AggregationMetadataBuildResult> {
    this.logger.debug(
      { context, maxDepth, timeoutMs },
      'Building aggregation metadata',
    );

    if (maxDepth <= 0) {
      return {
        type: context.ism.type,
        ismAddress: context.ism.address,
        threshold: context.ism.threshold,
        modules: [],
        metadata: undefined,
      };
    }

    // Build metadata for each submodule in parallel
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

    // Convert results to MetadataBuildResult array
    const moduleResults: MetadataBuildResult[] = results.map(
      (result, index) => {
        if (result.status === 'rejected') {
          this.logger.warn(
            `Failed to build for submodule ${index}: ${result.reason}`,
          );
          // Return a minimal result for failed modules
          const module = context.ism.modules[index] as DerivedIsmConfig;
          return {
            type: module.type,
            ismAddress: module.address,
            metadata: undefined,
          } as MetadataBuildResult;
        } else {
          this.logger.debug(`Built metadata for submodule ${index}`);
          return result.value;
        }
      },
    );

    // Count modules that have buildable metadata
    const buildableModules = moduleResults.filter(
      (r) => r.metadata !== undefined,
    );
    const buildableCount = buildableModules.length;
    const quorumMet = buildableCount >= context.ism.threshold;

    this.logger.debug(
      { buildableCount, threshold: context.ism.threshold, quorumMet },
      `Aggregation submodule build status`,
    );

    // Build the result
    const result: AggregationMetadataBuildResult = {
      type: context.ism.type,
      ismAddress: context.ism.address,
      threshold: context.ism.threshold,
      modules: moduleResults,
    };

    // Only encode metadata if quorum is met
    if (quorumMet) {
      // Only include the first threshold metadatas for encoding
      const metadatas: (string | null)[] = moduleResults.map((r) =>
        r.metadata !== undefined ? r.metadata : null,
      );

      let count = 0;
      for (let i = 0; i < metadatas.length; i++) {
        if (metadatas[i] === null) continue;
        count += 1;
        if (count > context.ism.threshold) metadatas[i] = null;
      }

      result.metadata = AggregationMetadataBuilder.encode({
        ...context.ism,
        submoduleMetadata: metadatas,
      });
    }

    return result;
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
