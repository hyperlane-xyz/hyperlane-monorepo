import { TransactionReceipt } from '@ethersproject/providers';

import { WithAddress, assert, rootLogger } from '@hyperlane-xyz/utils';

import { deepFind } from '../../../../utils/dist/objects.js';
import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { DispatchedMessage } from '../../core/types.js';
import { DerivedHookConfigWithAddress } from '../../hook/EvmHookReader.js';
import { HookType, MerkleTreeHookConfig } from '../../hook/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { DerivedIsmConfigWithAddress, NullIsmConfig } from '../EvmIsmReader.js';
import {
  AggregationIsmConfig,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
  ismTypeToModuleType,
} from '../types.js';

import {
  AggregationIsmMetadata,
  AggregationIsmMetadataBuilder,
} from './aggregation.js';
import { MultisigIsmMetadata, MultisigMetadataBuilder } from './multisig.js';
import { NullIsmMetadata, NullMetadataBuilder } from './null.js';

export type StructuredMetadata =
  | AggregationIsmMetadata
  | MultisigIsmMetadata
  | NullIsmMetadata;

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
  private nullMetadataBuilder: NullMetadataBuilder;

  protected multiProvider: MultiProvider;
  protected logger = rootLogger.child({ module: 'BaseMetadataBuilder' });

  constructor(core: HyperlaneCore) {
    this.multisigMetadataBuilder = new MultisigMetadataBuilder(core);
    this.aggregationIsmMetadataBuilder = new AggregationIsmMetadataBuilder(
      this,
    );
    this.nullMetadataBuilder = new NullMetadataBuilder(core.multiProvider);
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
    const moduleType = ismTypeToModuleType(ism.type);
    /* eslint-disable no-case-declarations */
    switch (moduleType) {
      case ModuleType.NULL:
        const nullIsmConfig = ism as WithAddress<NullIsmConfig>;
        return this.nullMetadataBuilder.build(message, { ism: nullIsmConfig });

      case ModuleType.MERKLE_ROOT_MULTISIG:
      case ModuleType.MESSAGE_ID_MULTISIG:
        const multisigIsmConfig = ism as WithAddress<MultisigIsmConfig>;
        const merkleTreeHook = deepFind(
          hook,
          (v): v is WithAddress<MerkleTreeHookConfig> =>
            v.type === HookType.MERKLE_TREE && v.address !== undefined,
        );
        assert(merkleTreeHook, 'Merkle tree hook context not found');
        return this.multisigMetadataBuilder.build(message, {
          ism: multisigIsmConfig,
          hook: merkleTreeHook,
          dispatchTx,
        });

      case ModuleType.ROUTING:
        const routingIsmConfig = ism as WithAddress<RoutingIsmConfig>;
        const originChain = this.multiProvider.getChainName(
          message.parsed.origin,
        );
        const subModuleConfig = routingIsmConfig.domains[
          originChain
        ] as DerivedIsmConfigWithAddress;
        const subContext = {
          ...context,
          ism: subModuleConfig,
        };
        return this.build(message, subContext, maxDepth - 1);

      case ModuleType.AGGREGATION:
        const aggregationIsmConfig = ism as WithAddress<AggregationIsmConfig>;
        return this.aggregationIsmMetadataBuilder.build(
          message,
          { ...context, ism: aggregationIsmConfig },
          maxDepth - 1,
        );

      default:
        throw new Error(`Unsupported ISM type: ${moduleType}`);
    }
    /* eslint-enable no-case-declarations */
  }
}
