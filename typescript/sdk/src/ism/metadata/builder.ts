import { WithAddress, eqAddress } from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { DispatchedMessage } from '../../core/types.js';
import { DerivedIsmConfigWithAddress } from '../read.js';
import { IsmConfig, IsmType } from '../types.js';

import {
  AggregationIsmMetadata,
  AggregationIsmMetadataBuilder,
} from './aggregation.js';
import { MultisigMetadata, MultisigMetadataBuilder } from './multisig.js';

export interface MetadataBuilder<T extends IsmConfig, M> {
  build(message: DispatchedMessage, ismConfig: WithAddress<T>): Promise<string>;
  encode?(metadata: M): string;
  decode?(metadata: string): M;
}

type StructuredMetadata = AggregationIsmMetadata | MultisigMetadata;

export class BaseMetadataBuilder
  implements MetadataBuilder<DerivedIsmConfigWithAddress, StructuredMetadata>
{
  constructor(protected readonly core: HyperlaneCore) {}

  async build(
    message: DispatchedMessage,
    ismConfig?: DerivedIsmConfigWithAddress,
  ): Promise<string> {
    if (!ismConfig) {
      ismConfig = await this.core.getRecipientIsmConfig(message);
    }

    if (ismConfig.type === IsmType.TRUSTED_RELAYER) {
      const destinationSigner = await this.core.multiProvider.getSignerAddress(
        message.parsed.destination,
      );
      if (!eqAddress(destinationSigner, ismConfig.relayer)) {
        throw new Error(
          `${destinationSigner} does not match trusted relayer ${ismConfig.relayer}`,
        );
      }
    }

    /* eslint-disable no-case-declarations */
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
    /* eslint-enable no-case-declarations */
  }
}
