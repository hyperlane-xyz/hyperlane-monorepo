import { IsmType } from '@hyperlane-xyz/sdk';

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
    case IsmType.STORAGE_MERKLE_ROOT_MULTISIG:
    case IsmType.STORAGE_MESSAGE_ID_MULTISIG:
      return MultisigMetadataBuilder.decode(metadata, ism.type);

    case IsmType.AGGREGATION:
    case IsmType.STORAGE_AGGREGATION:
      return AggregationMetadataBuilder.decode(
        metadata,
        { ...context, ism },
        decodeIsmMetadata,
      );

    case IsmType.ROUTING:
      return DynamicRoutingMetadataBuilder.decode(
        metadata,
        {
          ...context,
          ism,
        },
        decodeIsmMetadata,
      );

    case IsmType.ARB_L2_TO_L1:
      return ArbL2ToL1MetadataBuilder.decode(metadata, {
        ...context,
        ism,
      });

    // Both hybrids are NULL-module-type: they gate on flow state rather than on
    // metadata, so BaseMetadataBuilder submits empty metadata for them.
    case IsmType.NET_FLOW_RATE_LIMITED:
    case IsmType.DELAYED_FLOW_ROUTER:
      return NullMetadataBuilder.decode(ism);

    case IsmType.MAILBOX_DEFAULT:
      return DynamicRoutingMetadataBuilder.decodeMailboxDefault(metadata, {
        message: context.message,
        dispatchTx: context.dispatchTx,
        hook: context.hook,
        ism,
      });

    default:
      throw new Error(`Unsupported ISM type: ${ism.type}`);
  }
}
