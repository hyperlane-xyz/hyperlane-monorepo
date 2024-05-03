import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { DispatchedMessage } from '../../core/types.js';
import { DerivedIsmConfigWithAddress } from '../read.js';
import { IsmType } from '../types.js';

import {
  AggregationIsmMetadata,
  AggregationIsmMetadataBuilder,
} from './aggregation.js';
import { MultisigMetadata, MultisigMetadataBuilder } from './multisig.js';

type NullMetadata = {
  type:
    | IsmType.PAUSABLE
    | IsmType.TEST_ISM
    | IsmType.OP_STACK
    | IsmType.TRUSTED_RELAYER;
};

export type StructuredMetadata =
  | AggregationIsmMetadata
  | MultisigMetadata
  | NullMetadata;

export interface MetadataBuilder<T extends DerivedIsmConfigWithAddress> {
  build(message: DispatchedMessage, ismConfig: T): Promise<string>;
}

export class BaseMetadataBuilder
  implements MetadataBuilder<DerivedIsmConfigWithAddress>
{
  constructor(protected readonly core: HyperlaneCore) {}

  async build(
    message: DispatchedMessage,
    ismConfig?: DerivedIsmConfigWithAddress,
  ): Promise<string> {
    if (!ismConfig) {
      ismConfig = await this.core.getRecipientIsmConfig(message);
    }

    switch (ismConfig.type) {
      case IsmType.TRUSTED_RELAYER:
      case IsmType.PAUSABLE:
      case IsmType.TEST_ISM:
      case IsmType.OP_STACK:
        return '0x'; // NULL metadata
      case IsmType.AGGREGATION:
        return new AggregationIsmMetadataBuilder(this).build(
          message,
          ismConfig,
        );
      case IsmType.MERKLE_ROOT_MULTISIG:
      case IsmType.MESSAGE_ID_MULTISIG:
        return new MultisigMetadataBuilder(this.core).build(message, ismConfig);
      case IsmType.ROUTING:
      case IsmType.FALLBACK_ROUTING:
        const originChain = this.core.multiProvider.getChainName(
          message.parsed.origin,
        );
        return this.build(
          message,
          ismConfig.domains[originChain] as DerivedIsmConfigWithAddress,
        );
      default:
        throw new Error(`Unknown ISM config: ${ismConfig}`);
    }
  }
}
