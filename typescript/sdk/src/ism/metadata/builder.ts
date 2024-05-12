import { TransactionReceipt } from '@ethersproject/providers';

import {
  WithAddress,
  assert,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { deepFind } from '../../../../utils/dist/objects.js';
import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { DispatchedMessage } from '../../core/types.js';
import { DerivedHookConfigWithAddress } from '../../hook/EvmHookReader.js';
import { HookType, MerkleTreeHookConfig } from '../../hook/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { DerivedIsmConfigWithAddress } from '../EvmIsmReader.js';
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

  protected multiProvider: MultiProvider;
  protected logger = rootLogger.child({ module: 'BaseMetadataBuilder' });

  constructor(core: HyperlaneCore) {
    this.multisigMetadataBuilder = new MultisigMetadataBuilder(core);
    this.aggregationIsmMetadataBuilder = new AggregationIsmMetadataBuilder(
      this,
    );
    this.multiProvider = core.multiProvider;
  }

  // assumes that all post dispatch hooks are included in dispatchTx logs
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
    this.logger.debug(
      { maxDepth, context },
      `Building ${context.ism.type} metadata`,
    );

    const { ism, hook, dispatchTx } = context;
    /* eslint-disable no-case-declarations */
    switch (ism.type) {
      // Null
      case IsmType.TRUSTED_RELAYER:
        const destinationSigner = await this.multiProvider.getSignerAddress(
          message.parsed.destination,
        );
        assert(
          eqAddress(destinationSigner, ism.relayer),
          `Destination signer ${destinationSigner} does not match trusted relayer ${ism.relayer}`,
        );
      /* eslint-disable-next-line no-fallthrough */
      case IsmType.PAUSABLE:
      case IsmType.TEST_ISM:
      case IsmType.OP_STACK:
        return '0x';

      // Multisig
      case IsmType.MERKLE_ROOT_MULTISIG:
      case IsmType.MESSAGE_ID_MULTISIG:
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
              this.multiProvider.getChainName(message.parsed.origin)
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
    /* eslint-enable no-case-declarations */
  }
}
