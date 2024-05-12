import { TransactionReceipt } from '@ethersproject/providers';

import {
  WithAddress,
  assert,
  fromHexString,
  rootLogger,
  runWithTimeout,
  toHexString,
} from '@hyperlane-xyz/utils';

import { DispatchedMessage } from '../../core/types.js';
import { DerivedHookConfigWithAddress } from '../../hook/EvmHookReader.js';
import { DerivedIsmConfigWithAddress } from '../EvmIsmReader.js';
import { AggregationIsmConfig, IsmType } from '../types.js';

import { BaseMetadataBuilder, MetadataBuilder } from './builder.js';

// null indicates that metadata is NOT INCLUDED for this submodule
// empty or 0x string indicates that metadata is INCLUDED but NULL
export interface AggregationIsmMetadata {
  type: IsmType.AGGREGATION;
  submoduleMetadata: Array<string | null>;
}

const RANGE_SIZE = 4;

// adapted from rust/agents/relayer/src/msg/metadata/aggregation.rs
export class AggregationIsmMetadataBuilder
  implements
    MetadataBuilder<
      WithAddress<AggregationIsmConfig>,
      DerivedHookConfigWithAddress
    >
{
  protected logger = rootLogger.child({
    module: 'AggregationIsmMetadataBuilder',
  });

  constructor(protected readonly base: BaseMetadataBuilder) {}

  async build(
    message: DispatchedMessage,
    context: {
      ism: WithAddress<AggregationIsmConfig>;
      hook: DerivedHookConfigWithAddress;
      dispatchTx: TransactionReceipt;
    },
    maxDepth = 10,
    timeout = maxDepth * 1000,
  ): Promise<string> {
    assert(maxDepth > 0, 'Max depth reached');
    const promises = await Promise.allSettled(
      context.ism.modules.map((module) => {
        const subContext = {
          ...context,
          ism: module as DerivedIsmConfigWithAddress,
        };
        return runWithTimeout(timeout, () =>
          this.base.build(message, subContext, maxDepth - 1),
        );
      }),
    );
    const submoduleMetadata = promises.map((r) =>
      r.status === 'fulfilled' ? r.value ?? null : null,
    );
    const included = submoduleMetadata.filter((m) => m !== null).length;
    if (included < context.ism.threshold) {
      throw new Error(
        `Only built ${included} of ${context.ism.threshold} required modules`,
      );
    }

    return AggregationIsmMetadataBuilder.encode({
      ...context.ism,
      submoduleMetadata,
    });
  }

  static rangeIndex(index: number): number {
    return index * 2 * RANGE_SIZE;
  }

  static encode(metadata: AggregationIsmMetadata): string {
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

  static decode(metadata: string, count: number): AggregationIsmMetadata {
    const submoduleMetadata = [];
    for (let i = 0; i < count; i++) {
      const range = this.metadataRange(metadata, i);
      const submeta = range.start > 0 ? range.encoded : null;
      submoduleMetadata.push(submeta);
    }
    return { type: IsmType.AGGREGATION, submoduleMetadata };
  }
}
