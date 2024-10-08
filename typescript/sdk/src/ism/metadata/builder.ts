/* eslint-disable no-case-declarations */
import { TransactionReceipt } from '@ethersproject/providers';

import { WithAddress, assert, rootLogger } from '@hyperlane-xyz/utils';

import { deepFind } from '../../../../utils/dist/objects.js';
import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { DispatchedMessage } from '../../core/types.js';
import { DerivedHookConfig } from '../../hook/EvmHookReader.js';
import {
  ArbL2ToL1HookConfig,
  HookType,
  MerkleTreeHookConfig,
} from '../../hook/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { DerivedIsmConfig } from '../EvmIsmReader.js';
import { IsmType } from '../types.js';

import {
  AggregationMetadata,
  AggregationMetadataBuilder,
} from './aggregation.js';
import { ArbL2ToL1Metadata, ArbL2ToL1MetadataBuilder } from './arbL2ToL1.js';
import { MultisigMetadata, MultisigMetadataBuilder } from './multisig.js';
import { NullMetadata, NullMetadataBuilder } from './null.js';
import { RoutingMetadata, RoutingMetadataBuilder } from './routing.js';

export type StructuredMetadata =
  | NullMetadata
  | MultisigMetadata
  | ArbL2ToL1Metadata
  | AggregationMetadata<any>
  | RoutingMetadata<any>;

export interface MetadataContext<
  IsmContext = DerivedIsmConfig,
  HookContext = DerivedHookConfig,
> {
  message: DispatchedMessage;
  dispatchTx: TransactionReceipt;
  ism: IsmContext;
  hook: HookContext;
}

export interface MetadataBuilder {
  build(context: MetadataContext): Promise<string>;
}

export class BaseMetadataBuilder implements MetadataBuilder {
  public nullMetadataBuilder: NullMetadataBuilder;
  public multisigMetadataBuilder: MultisigMetadataBuilder;
  public aggregationMetadataBuilder: AggregationMetadataBuilder;
  public routingMetadataBuilder: RoutingMetadataBuilder;
  public arbL2ToL1MetadataBuilder: ArbL2ToL1MetadataBuilder;

  public multiProvider: MultiProvider;
  protected logger = rootLogger.child({ module: 'BaseMetadataBuilder' });

  constructor(core: HyperlaneCore) {
    this.multisigMetadataBuilder = new MultisigMetadataBuilder(core);
    this.aggregationMetadataBuilder = new AggregationMetadataBuilder(this);
    this.routingMetadataBuilder = new RoutingMetadataBuilder(this);
    this.nullMetadataBuilder = new NullMetadataBuilder(core.multiProvider);
    this.arbL2ToL1MetadataBuilder = new ArbL2ToL1MetadataBuilder(core);
    this.multiProvider = core.multiProvider;
  }

  // assumes that all post dispatch hooks are included in dispatchTx logs
  async build(context: MetadataContext, maxDepth = 10): Promise<string> {
    this.logger.debug(
      { context, maxDepth },
      `Building ${context.ism.type} metadata`,
    );
    assert(maxDepth > 0, 'Max depth reached');

    const { ism, hook } = context;
    switch (ism.type) {
      case IsmType.TRUSTED_RELAYER:
      case IsmType.TEST_ISM:
      case IsmType.OP_STACK:
      case IsmType.PAUSABLE:
        return this.nullMetadataBuilder.build({ ...context, ism });

      case IsmType.MERKLE_ROOT_MULTISIG:
      case IsmType.MESSAGE_ID_MULTISIG:
        if (typeof hook === 'string') {
          throw new Error('Hook context must be an object (for multisig ISM)');
        }
        const merkleTreeHook = deepFind(
          hook,
          (v): v is WithAddress<MerkleTreeHookConfig> =>
            v.type === HookType.MERKLE_TREE && !!v.address,
        );
        assert(merkleTreeHook, 'Merkle tree hook context not found');
        return this.multisigMetadataBuilder.build({
          ...context,
          ism,
          hook: merkleTreeHook,
        });

      case IsmType.ROUTING:
        return this.routingMetadataBuilder.build(
          {
            ...context,
            ism,
          },
          maxDepth,
        );

      case IsmType.AGGREGATION:
        return this.aggregationMetadataBuilder.build(
          { ...context, ism },
          maxDepth,
        );

      case IsmType.ARB_L2_TO_L1: {
        const hookConfig = hook as WithAddress<ArbL2ToL1HookConfig>;
        return this.arbL2ToL1MetadataBuilder.build({
          ...context,
          ism,
          hook: hookConfig,
        });
      }

      default:
        throw new Error(`Unsupported ISM type: ${ism.type}`);
    }
  }

  static decode(
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
        return RoutingMetadataBuilder.decode(metadata, { ...context, ism });

      case IsmType.ARB_L2_TO_L1:
        return ArbL2ToL1MetadataBuilder.decode(metadata, {
          ...context,
          ism,
        });

      default:
        throw new Error(`Unsupported ISM type: ${ism.type}`);
    }
  }
}
