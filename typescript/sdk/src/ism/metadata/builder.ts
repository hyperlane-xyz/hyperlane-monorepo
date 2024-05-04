import { TransactionReceipt } from '@ethersproject/providers';

import { WithAddress, assert, eqAddress } from '@hyperlane-xyz/utils';

import { deepFind } from '../../../../utils/dist/objects.js';
import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { DispatchedMessage } from '../../core/types.js';
import { DerivedHookConfigWithAddress } from '../../hook/read.js';
import { HookType, MerkleTreeHookConfig } from '../../hook/types.js';
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

export interface MetadataBuilder<
  I extends DerivedIsmConfigWithAddress,
  H extends DerivedHookConfigWithAddress,
> {
  build(
    message: DispatchedMessage,
    context: {
      dispatchTx: TransactionReceipt;
      hook: H;
      ism: I;
    },
  ): Promise<string>;
}

export class BaseMetadataBuilder
  implements
    MetadataBuilder<DerivedIsmConfigWithAddress, DerivedHookConfigWithAddress>
{
  private multisigMetadataBuilder: MultisigMetadataBuilder;
  private aggregationIsmMetadataBuilder: AggregationIsmMetadataBuilder;

  constructor(protected readonly core: HyperlaneCore) {
    this.multisigMetadataBuilder = new MultisigMetadataBuilder(core);
    this.aggregationIsmMetadataBuilder = new AggregationIsmMetadataBuilder(
      this,
    );
  }

  async build(
    message: DispatchedMessage,
    context: {
      dispatchTx: TransactionReceipt;
      hook: DerivedHookConfigWithAddress;
      ism: DerivedIsmConfigWithAddress;
    },
    maxDepth = 10,
  ): Promise<string> {
    assert(maxDepth > 0, 'Max depth reached');

    if (context.ism.type === IsmType.TRUSTED_RELAYER) {
      const destinationSigner = await this.core.multiProvider.getSignerAddress(
        message.parsed.destination,
      );
      assert(
        eqAddress(destinationSigner, context.ism.relayer),
        `Destination signer ${destinationSigner} does not match trusted relayer ${context.ism.relayer}`,
      );
    }

    const { ism, hook, dispatchTx } = context;
    switch (ism.type) {
      // Null
      case IsmType.TRUSTED_RELAYER:
      case IsmType.PAUSABLE:
      case IsmType.TEST_ISM:
      case IsmType.OP_STACK:
        return '0x';

      // Multisig
      case IsmType.MERKLE_ROOT_MULTISIG:
      case IsmType.MESSAGE_ID_MULTISIG:
        // eslint-disable-next-line no-case-declarations
        const merkleTreeHook = deepFind(
          hook,
          (v): v is WithAddress<MerkleTreeHookConfig> =>
            v.type === HookType.MERKLE_TREE && v.address !== undefined,
        );
        assert(merkleTreeHook, 'Merkle tree hook context not found');
        return this.multisigMetadataBuilder.build(message, {
          ism,
          hook: merkleTreeHook,
          dispatchTx,
        });

      // Routing
      case IsmType.ROUTING:
      case IsmType.FALLBACK_ROUTING:
        return this.build(
          message,
          {
            ...context,
            ism: ism.domains[
              this.core.multiProvider.getChainName(message.parsed.origin)
            ] as DerivedIsmConfigWithAddress,
          },
          maxDepth - 1,
        );

      // Aggregation
      case IsmType.AGGREGATION:
        return this.aggregationIsmMetadataBuilder.build(
          message,
          { ...context, ism },
          maxDepth - 1,
        );
    }
  }
}
