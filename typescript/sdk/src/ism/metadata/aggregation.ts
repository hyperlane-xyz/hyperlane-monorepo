import { fromHexString, toHexString } from '@hyperlane-xyz/utils';

// null indicates that metadata is NOT INCLUDED for this submodule
// empty or 0x string indicates that metadata is INCLUDED but NULL
export interface AggregationIsmMetadata {
  submoduleMetadata: Array<string | null>;
}

const RANGE_SIZE = 4;

// adapted from rust/agents/relayer/src/msg/metadata/aggregation.rs
export class AggregationIsmMetadataBuilder {
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
    return { submoduleMetadata };
  }
}
