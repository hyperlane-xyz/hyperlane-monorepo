import {
  ArbitrumProvider,
  ChildToParentMessageReader,
  ChildToParentMessageStatus,
  ChildToParentTransactionEvent,
  EventArgs,
} from '@arbitrum/sdk';
import { L2ToL1TxEvent } from '@arbitrum/sdk/dist/lib/abi/ArbSys.js';
import { BigNumber, BytesLike, providers, utils } from 'ethers';

import {
  AbstractMessageIdAuthorizedIsm__factory,
  ArbSys__factory,
  IOutbox__factory,
} from '@hyperlane-xyz/core';
import { WithAddress, assert, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { ArbL2ToL1HookConfig } from '../../hook/types.js';
import { findMatchingLogEvents } from '../../utils/logUtils.js';
import { ArbL2ToL1IsmConfig, IsmType } from '../types.js';

import type { MetadataBuilder, MetadataContext } from './types.js';

export type NitroChildToParentTransactionEvent = EventArgs<L2ToL1TxEvent>;
export type ArbL2ToL1Metadata = Omit<
  NitroChildToParentTransactionEvent,
  'hash'
> & {
  proof: BytesLike[]; // bytes32[16]
};

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
      if (status == ChildToParentMessageStatus.UNCONFIRMED) {
        const waitingPeriod = await this.getWaitingBlocksUntilReady(
          reader,
          arbProvider,
        );
        throw new Error(
          `Arbitrum L2ToL1 message isn't ready for relay. Wait ${waitingPeriod} blocks until the challenge period before relaying again.`,
        );
      } else if (status == ChildToParentMessageStatus.EXECUTED) {
        throw new Error('Arbitrum L2ToL1 message has already been executed');
      }

      const outboxProof = await this.getArbitrumOutboxProof(
        reader,
        arbProvider,
      );

      const metadata: ArbL2ToL1Metadata = {
        ...l2ToL1TxEvent,
        proof: outboxProof,
      };

      return metadata;
    } else {
      throw new Error(
        'Error in building calldata for Arbitrum native bridge call',
      );
    }
  }

  // waiting period left until the challenge period is over
  async getWaitingBlocksUntilReady(
    reader: ChildToParentMessageReader,
    provider: ArbitrumProvider,
  ): Promise<BigNumber> {
    const firstBlock = await reader.getFirstExecutableBlock(provider);
    if (!firstBlock) {
      throw new Error('No first executable block found');
    }
    const currentBlock = BigNumber.from(await provider.getBlockNumber());
    if (currentBlock.gt(firstBlock)) {
      throw new Error('First executable block is in the past');
    }
    const waitingPeriod = firstBlock.sub(currentBlock);

    return waitingPeriod;
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
    if (!proof) {
      throw new Error('No outbox proof found');
    }
    return 'proof' in proof ? proof.proof : proof;
  }

  static decode(
    metadata: string,
    _: MetadataContext<WithAddress<ArbL2ToL1IsmConfig>>,
  ): ArbL2ToL1Metadata {
    const abiCoder = new utils.AbiCoder();
    const outboxInterface = IOutbox__factory.createInterface();
    const executeTransactionInputs =
      outboxInterface.functions[
        'executeTransaction(bytes32[],uint256,address,address,uint256,uint256,uint256,uint256,bytes)'
      ].inputs;
    const executeTransactionTypes = executeTransactionInputs
      .map((input) => input.type)
      .filter((_, index, array) => index !== array.length - 2); // remove callvalue from types (because the ArbL2ToL1Ism doesn't allow it)
    const decoded = abiCoder.decode(executeTransactionTypes, metadata);

    return Object.fromEntries(
      Object.keys({} as ArbL2ToL1Metadata).map((key, i) => [key, decoded[i]]),
    ) as ArbL2ToL1Metadata;
  }

  static encodeArbL2ToL1Metadata(metadata: ArbL2ToL1Metadata): string {
    const abiCoder = new utils.AbiCoder();
    const outboxInterface = IOutbox__factory.createInterface();
    const executeTransactionInputs =
      outboxInterface.functions[
        'executeTransaction(bytes32[],uint256,address,address,uint256,uint256,uint256,uint256,bytes)'
      ].inputs;
    const executeTransactionTypes = executeTransactionInputs.map(
      (input) => input.type,
    );
    return abiCoder.encode(executeTransactionTypes, [
      metadata.proof,
      metadata.position,
      metadata.caller,
      metadata.destination,
      metadata.arbBlockNum,
      metadata.ethBlockNum,
      metadata.timestamp,
      metadata.callvalue,
      metadata.data,
    ]);
  }
}
