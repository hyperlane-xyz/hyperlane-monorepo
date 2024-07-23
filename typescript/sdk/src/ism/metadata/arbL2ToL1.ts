import {
  ArbitrumProvider,
  ChildToParentMessageReader,
  ChildToParentTransactionEvent,
} from '@arbitrum/sdk';
import { assert } from 'console';
import { BigNumber, BytesLike, providers, utils } from 'ethers';

import {
  AbstractMessageIdAuthorizedIsm__factory,
  ArbSys__factory,
} from '@hyperlane-xyz/core';
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

interface ArbL2ToL1Metadata {
  proof: BytesLike[];
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
    const matchingL2Tx = context.dispatchTx.logs
      .filter((log) => eqAddressEvm(log.address, context.hook.arbSys))
      .map((log) => ArbSys.parseLog(log))
      .find((log) => {
        const calldata: string = log.args.data;
        const messageIdHex = context.message.id.slice(2);
        return calldata && calldata.includes(messageIdHex);
      });

    assert(matchingL2Tx, 'No matching L2ToL1Tx event found');
    this.logger.debug({ matchingL2Tx }, 'Found matching L2ToL1Tx event');

    if (matchingL2Tx) {
      const l2ToL1TxEvent: ChildToParentTransactionEvent = {
        ...matchingL2Tx.args,
        caller: matchingL2Tx.args.caller,
        destination: matchingL2Tx.args.destination,
        hash: matchingL2Tx.args.hash,
        position: matchingL2Tx.args.position,
        arbBlockNum: matchingL2Tx.args.arbBlockNum,
        ethBlockNum: matchingL2Tx.args.ethBlockNum,
        timestamp: matchingL2Tx.args.timestamp,
        callvalue: matchingL2Tx.args.callvalue,
        data: matchingL2Tx.args.data,
      };

      const reader = new ChildToParentMessageReader(
        this.core.multiProvider.getProvider('sepolia'),
        l2ToL1TxEvent,
      );

      const baseProvider = new providers.JsonRpcProvider(
        this.core.multiProvider.getChainMetadata(
          'arbitrumsepolia',
        ).rpcUrls[0].http,
      );
      const arbProvider = new ArbitrumProvider(baseProvider, {
        name: 'arbitrum-sepolia',
        chainId: 421614,
      });

      const status = await reader.status(arbProvider);
      // need to wait for the challenge period to pass before relaying
      if (!status) {
        throw new Error(
          `Arbitrum L2ToL1 message isn't ready for relay. Wait until the challenge period before relaying again.`,
        );
      }

      const outboxProofResult =
        (await reader.getOutboxProof(arbProvider)) ?? [];

      // extract the proof key from MessageBatchProofInfo
      const outboxProof: string[] =
        'proof' in outboxProofResult
          ? outboxProofResult.proof
          : outboxProofResult ?? [];

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

      const encodedMetadata =
        ArbL2ToL1MetadataBuilder.encodeArbL2ToL1Metadata(metadata);
      return encodedMetadata;
    }

    return '0x';
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
