import { IsmType } from '../types.js';

import { AggregationMetadataBuilder } from './aggregation.js';
import { ArbL2ToL1MetadataBuilder } from './arbL2ToL1.js';
import { MultisigMetadataBuilder } from './multisig.js';
import { NullMetadataBuilder } from './null.js';
import { DynamicRoutingMetadataBuilder } from './routing.js';
import { MetadataContext, StructuredMetadata } from './types.js';

export function decodeIsmMetadata(
  metadata: string,
  context: MetadataContext,
): StructuredMetadata {
  const { ism } = context;
  switch (ism.type) {
    case IsmType.TRUSTED_RELAYER:
      return NullMetadataBuilder.decode(ism);

    case IsmType.MERKLE_ROOT_MULTISIG:
    case IsmType.MESSAGE_ID_MULTISIG:
      return MultisigMetadataBuilder.decode(metadata, ism.type);

    case IsmType.AGGREGATION:
      return AggregationMetadataBuilder.decode(metadata, { ...context, ism });

    case IsmType.ROUTING:
      return DynamicRoutingMetadataBuilder.decode(metadata, {
        ...context,
        ism,
      });

    case IsmType.ARB_L2_TO_L1:
      return ArbL2ToL1MetadataBuilder.decode(metadata, {
        ...context,
        ism,
      });

    default:
      throw new Error(`Unsupported ISM type: ${ism.type}`);
  }
}
