import { WithAddress } from '@hyperlane-xyz/utils';

import { DispatchedMessage } from '../../core/types.js';
import { DerivedIsmConfigWithAddress } from '../read.js';
import { AggregationIsmConfig } from '../types.js';

import { BaseMetadataBuilder, MetadataBuilder } from './builder.js';

export interface AggregationIsmMetadata {
  submoduleMetadata: string[];
}

const RANGE_SIZE = 4;

export class AggregationIsmMetadataBuilder
  implements MetadataBuilder<WithAddress<AggregationIsmConfig>>
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
    return AggregationIsmMetadataBuilder.encode({
      submoduleMetadata: metadatas,
    });
  }

  static encode(metadata: AggregationIsmMetadata): string {
    const rangeSize = 2 * RANGE_SIZE * metadata.submoduleMetadata.length;

    let encoded = Buffer.alloc(rangeSize, 0);
    metadata.submoduleMetadata.forEach((meta, index) => {
      if (meta.length === 0) {
        return;
      }

      const start = encoded.length;
      encoded = Buffer.concat([encoded, Buffer.from(meta, 'hex')]);
      const end = encoded.length;

      const rangeStart = 2 * RANGE_SIZE * index;
      encoded.writeUint32BE(start, rangeStart);
      encoded.writeUint32BE(end, rangeStart + RANGE_SIZE);
    });

    return encoded.toString('hex');
  }

  static metadataRange(metadata: string, index: number): string {
    const rangeStart = index * 2 * RANGE_SIZE;
    const encoded = Buffer.from(metadata, 'hex');
    const start = encoded.readUint32BE(rangeStart);
    const end = encoded.readUint32BE(rangeStart + RANGE_SIZE);
    return encoded.subarray(start, end).toString('hex');
  }

  static hasMetadata(metadata: string, index: number): boolean {
    return this.metadataRange(metadata, index).length > 0;
  }

  static decode(metadata: string, count: number): AggregationIsmMetadata {
    const submoduleMetadata = [];
    for (let i = 0; i < count; i++) {
      submoduleMetadata.push(this.metadataRange(metadata, i));
    }
    return { submoduleMetadata };
  }
}
