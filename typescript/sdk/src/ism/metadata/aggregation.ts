import { defaultAbiCoder } from '@ethersproject/abi';

import { WithAddress, assert } from '@hyperlane-xyz/utils';

import { DispatchedMessage } from '../../core/types.js';
import { DerivedIsmConfigWithAddress } from '../read.js';
import { AggregationIsmConfig } from '../types.js';

import { BaseMetadataBuilder, MetadataBuilder } from './builder.js';

export interface AggregationIsmMetadata {
  submoduleMetadata: string[];
}

interface Range {
  start: number;
  end: number;
}

const RANGE_SIZE = 4;

export class AggregationIsmMetadataBuilder
  implements MetadataBuilder<AggregationIsmConfig, AggregationIsmMetadata>
{
  constructor(protected readonly base: BaseMetadataBuilder) {}

  async build(
    message: DispatchedMessage,
    ismConfig: WithAddress<AggregationIsmConfig>,
  ): Promise<string> {
    const metadatas = await Promise.all(
      ismConfig.modules.map((module) =>
        this.base.build(message, module as DerivedIsmConfigWithAddress),
      ),
    );
    return this.encode({ submoduleMetadata: metadatas });
  }

  encode(metadata: AggregationIsmMetadata): string {
    const lengths = metadata.submoduleMetadata.map((m) => m.length / 2);
    const ranges: Range[] = [];

    let offset = 0;
    for (const length of lengths) {
      ranges.push({ start: offset, end: offset + length });
      offset += length;
    }

    let encoded = '';
    for (const range of ranges) {
      const encodedRange = defaultAbiCoder.encode(
        ['uint32', 'uint32'],
        [range.start, range.end],
      );
      assert(encodedRange.length === RANGE_SIZE * 2);
      encoded += encodedRange;
    }

    for (const m of metadata.submoduleMetadata) {
      encoded += m;
    }

    return encoded;
  }

  metadataRange(metadata: string, index: number): Range {
    const start = index * RANGE_SIZE * 2;
    const mid = start + RANGE_SIZE;
    const end = mid + RANGE_SIZE;
    return {
      start: parseInt(metadata.slice(start, mid)),
      end: parseInt(metadata.slice(mid, end)),
    };
  }

  hasMetadata(metadata: string, index: number): boolean {
    const { start } = this.metadataRange(metadata, index);
    return start > 0;
  }

  decode(metadata: string): AggregationIsmMetadata {
    const submoduleMetadata = [];
    for (let i = 0; this.hasMetadata(metadata, i); i++) {
      const { start, end } = this.metadataRange(metadata, i);
      submoduleMetadata.push(metadata.slice(start, end));
    }
    return { submoduleMetadata };
  }
}
