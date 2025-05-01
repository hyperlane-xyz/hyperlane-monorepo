import {
  WithAddress,
  assert,
  deepFind,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import {
  ArbL2ToL1HookConfig,
  HookType,
  MerkleTreeHookConfig,
} from '../../hook/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { IsmType } from '../types.js';

import { AggregationMetadataBuilder } from './aggregation.js';
import { ArbL2ToL1MetadataBuilder } from './arbL2ToL1.js';
import { decodeIsmMetadata } from './decode.js';
import { MultisigMetadataBuilder } from './multisig.js';
import { NullMetadataBuilder } from './null.js';
import { DefaultFallbackRoutingMetadataBuilder } from './routing.js';
import type {
  MetadataBuilder,
  MetadataContext,
  StructuredMetadata,
} from './types.js';

export class BaseMetadataBuilder implements MetadataBuilder {
  public nullMetadataBuilder: NullMetadataBuilder;
  public multisigMetadataBuilder: MultisigMetadataBuilder;
  public aggregationMetadataBuilder: AggregationMetadataBuilder;
  public routingMetadataBuilder: DefaultFallbackRoutingMetadataBuilder;
  public arbL2ToL1MetadataBuilder: ArbL2ToL1MetadataBuilder;

  public multiProvider: MultiProvider;
  protected logger = rootLogger.child({ module: 'BaseMetadataBuilder' });

  constructor(core: HyperlaneCore) {
    this.multisigMetadataBuilder = new MultisigMetadataBuilder(core);
    this.aggregationMetadataBuilder = new AggregationMetadataBuilder(this);
    this.routingMetadataBuilder = new DefaultFallbackRoutingMetadataBuilder(
      this,
    );
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
        // eslint-disable-next-line no-case-declarations
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
      case IsmType.FALLBACK_ROUTING:
      case IsmType.ICA_ROUTING:
      case IsmType.AMOUNT_ROUTING:
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
        throw new Error(`Unsupported ISM: ${ism}`);
    }
  }

  static decode(
    metadata: string,
    context: MetadataContext,
  ): StructuredMetadata {
    return decodeIsmMetadata(metadata, context);
  }
}
