import {
  ArbitrumProvider,
  ChildToParentMessageReader,
  ChildToParentMessageStatus,
  ChildToParentTransactionEvent,
} from '@arbitrum/sdk';
import { assert } from 'console';
import { BigNumber, BytesLike, providers, utils } from 'ethers';

import {
  AbstractMessageIdAuthorizedIsm__factory,
  ArbSys__factory,
} from '@hyperlane-xyz/core';
import { Address, WithAddress, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { ArbL2ToL1HookConfig } from '../../hook/types.js';
import { findMatchingLogEvents } from '../../utils/logUtils.js';
import { ArbL2ToL1IsmConfig, IsmType } from '../types.js';

import { MetadataBuilder, MetadataContext } from './builder.js';

// type for the executeTransaction call to the Arbitrum bridge on the L1
export interface ArbL2ToL1Metadata {
  proof: BytesLike[]; // bytes32[16]
  index: BigNumber;
  l2Sender: Address;
  to: Address;
  l2Block: BigNumber;
  l1Block: BigNumber;
  l2Timestamp: BigNumber;
  data: BytesLike;
}

const ArbSys = ArbSys__factory.createInterface();

export class ArbL2ToL1MetadataBuilder implements MetadataBuilder {
  constructor(
    protected readonly core: HyperlaneCore,
    protected readonly logger = rootLogger.child({
      module: 'ArbL2ToL1MetadataBuilder',
    }),
  ) {}

  async build(
    context: MetadataContext<
      WithAddress<ArbL2ToL1IsmConfig>,
      WithAddress<ArbL2ToL1HookConfig>
    >,
  ): Promise<string> {
    assert(context.ism.type === IsmType.ARB_L2_TO_L1, 'Invalid ISM type');
    this.logger.debug({ context }, 'Building ArbL2ToL1 metadata');

    // if the executeTransaction call is already successful, we can call with null metadata
    const ism = AbstractMessageIdAuthorizedIsm__factory.connect(
      context.ism.address,
      this.core.multiProvider.getSigner(context.message.parsed.destination),
    );
    const verified = await ism.isVerified(context.message.id);
    if (verified) {
      this.logger.debug(
        'Message is already verified, relaying without metadata...',
      );
      return '0x';
    }

    // else build the metadata for outbox.executeTransaction call
    const metadata = await this.buildArbitrumBridgeCalldata(context);
    return ArbL2ToL1MetadataBuilder.encodeArbL2ToL1Metadata(metadata);
  }

  async buildArbitrumBridgeCalldata(
    context: MetadataContext<
      WithAddress<ArbL2ToL1IsmConfig>,
      WithAddress<ArbL2ToL1HookConfig>
    >,
  ): Promise<ArbL2ToL1Metadata> {
    const matchingL2TxEvent = findMatchingLogEvents(
      context.dispatchTx.logs,
      ArbSys,
      'L2ToL1Tx',
    ).find((log) => {
      const calldata: string = log.args.data;
      const messageIdHex = context.message.id.slice(2);
      return calldata && calldata.includes(messageIdHex);
    });

    assert(matchingL2TxEvent, 'No matching L2ToL1Tx event found');
    this.logger.debug({ matchingL2TxEvent }, 'Found matching L2ToL1Tx event');

    if (matchingL2TxEvent) {
      const [
        caller,
        destination,
        hash,
        position,
        arbBlockNum,
        ethBlockNum,
        timestamp,
        callvalue,
        data,
      ] = matchingL2TxEvent.args;
      const l2ToL1TxEvent: ChildToParentTransactionEvent = {
        caller,
        destination,
        hash,
        position,
        arbBlockNum,
        ethBlockNum,
        timestamp,
        callvalue,
        data,
      };

      const reader = new ChildToParentMessageReader(
        this.core.multiProvider.getProvider(context.hook.destinationChain),
        l2ToL1TxEvent,
      );

      const originChainMetadata = this.core.multiProvider.getChainMetadata(
        context.message.parsed.origin,
      );
      if (typeof originChainMetadata.chainId == 'string') {
        throw new Error(
          `Invalid chainId for ${originChainMetadata.name}: ${originChainMetadata.chainId}`,
        );
      }
      const baseProvider = new providers.JsonRpcProvider(
        originChainMetadata.rpcUrls[0].http,
      );
      const arbProvider = new ArbitrumProvider(baseProvider, {
        name: originChainMetadata.name,
        chainId: originChainMetadata.chainId,
      });

      const status = await this.getArbitrumBridgeStatus(reader, arbProvider);
      // need to wait for the challenge period to pass before relaying
      if (!status) {
        throw new Error(
          `Arbitrum L2ToL1 message isn't ready for relay. Wait until the challenge period before relaying again.`,
        );
      }

      const outboxProof = await this.getArbitrumOutboxProof(
        reader,
        arbProvider,
      );

      const metadata: ArbL2ToL1Metadata = {
        proof: outboxProof,
        index: l2ToL1TxEvent.position,
        l2Sender: l2ToL1TxEvent.caller,
        to: l2ToL1TxEvent.destination,
        l2Block: l2ToL1TxEvent.arbBlockNum,
        l1Block: l2ToL1TxEvent.ethBlockNum,
        l2Timestamp: l2ToL1TxEvent.timestamp,
        data: l2ToL1TxEvent.data,
      };

      return metadata;
    } else {
      throw new Error(
        'Error in building calldata for Arbitrum native bridge call',
      );
    }
  }

  async getArbitrumBridgeStatus(
    reader: ChildToParentMessageReader,
    provider: ArbitrumProvider,
  ): Promise<ChildToParentMessageStatus> {
    return reader.status(provider);
  }

  async getArbitrumOutboxProof(
    reader: ChildToParentMessageReader,
    provider: ArbitrumProvider,
  ): Promise<string[]> {
    const proof = (await reader.getOutboxProof(provider)) ?? [];
    return 'proof' in proof ? proof.proof : proof ?? [];
  }

  static decode(
    metadata: string,
    _: MetadataContext<WithAddress<ArbL2ToL1IsmConfig>>,
  ): ArbL2ToL1Metadata {
    const abiCoder = new utils.AbiCoder();
    const decoded = abiCoder.decode(
      [
        'bytes32[]',
        'uint256',
        'address',
        'address',
        'uint256',
        'uint256',
        'uint256',
        'bytes',
      ],
      metadata,
    );

    return {
      proof: decoded[0],
      index: decoded[1],
      l2Sender: decoded[2],
      to: decoded[3],
      l2Block: decoded[4],
      l1Block: decoded[5],
      l2Timestamp: decoded[6],
      data: decoded[7],
      // ...context,
    };
  }

  static encodeArbL2ToL1Metadata(metadata: ArbL2ToL1Metadata): string {
    const abiCoder = new utils.AbiCoder();
    return abiCoder.encode(
      [
        'bytes32[]',
        'uint256',
        'address',
        'address',
        'uint256',
        'uint256',
        'uint256',
        'bytes',
      ],
      [
        metadata.proof,
        metadata.index,
        metadata.l2Sender,
        metadata.to,
        metadata.l2Block,
        metadata.l1Block,
        metadata.l2Timestamp,
        metadata.data,
      ],
    );
  }
}
