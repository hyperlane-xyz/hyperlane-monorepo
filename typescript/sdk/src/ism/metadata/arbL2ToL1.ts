import {
  ArbitrumProvider,
  ChildToParentMessageReader,
  ChildToParentMessageStatus,
  ChildToParentTransactionEvent,
} from '@arbitrum/sdk';
import { assert } from 'console';
import { BigNumber, BytesLike, providers, utils } from 'ethers';

import { AbstractMessageIdAuthorizedIsm__factory } from '@hyperlane-xyz/core';
import {
  Address,
  WithAddress,
  eqAddressEvm,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneCore } from '../../core/HyperlaneCore.js';
import { ArbL2ToL1HookConfig } from '../../hook/types.js';
import { ArbL2ToL1IsmConfig, IsmType } from '../types.js';

import { MetadataBuilder, MetadataContext } from './builder.js';

export interface ArbL2ToL1Metadata {
  proof: BytesLike[];
  index: BigNumber;
  l2Sender: Address;
  to: Address;
  l2Block: BigNumber;
  l1Block: BigNumber;
  l2Timestamp: BigNumber;
  data: BytesLike;
}

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
    const matchingL2Tx = context.dispatchTx.logs
      .filter((log) => eqAddressEvm(log.address, context.hook.arbSys))
      .find((log) => {
        const calldata: string = log.data;
        const messageIdHex = context.message.id.slice(2);
        return calldata && calldata.includes(messageIdHex);
      });

    assert(matchingL2Tx, 'No matching L2ToL1Tx event found');
    this.logger.debug({ matchingL2Tx }, 'Found matching L2ToL1Tx event');

    if (matchingL2Tx) {
      const l2ToL1TxEvent: ChildToParentTransactionEvent = {
        caller: '0x' + matchingL2Tx.data.slice(26, 66),
        destination: '0x' + matchingL2Tx.topics[1].slice(-40),
        hash: BigNumber.from(matchingL2Tx.topics[2]),
        position: BigNumber.from(matchingL2Tx.topics[3]),
        arbBlockNum: BigNumber.from('0x' + matchingL2Tx.data.slice(66, 130)),
        ethBlockNum: BigNumber.from('0x' + matchingL2Tx.data.slice(130, 194)),
        timestamp: BigNumber.from('0x' + matchingL2Tx.data.slice(194, 258)),
        callvalue: BigNumber.from('0x' + matchingL2Tx.data.slice(258, 322)),
        data: '0x' + matchingL2Tx.data.slice(450, 522),
      };
      console.log('CHEESECAKE: L2ToL1TxEvent', l2ToL1TxEvent);

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
