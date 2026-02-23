import {
  ArbitrumProvider,
  ChildToParentMessageReader,
  ChildToParentMessageStatus,
  ChildToParentTransactionEvent,
} from '@arbitrum/sdk';
import {
  type Hex,
  decodeAbiParameters,
  encodeAbiParameters,
  parseAbiParameters,
} from 'viem';

import {
  AbstractMessageIdAuthorizedIsm__factory,
  ArbSys__factory,
} from '@hyperlane-xyz/core';
import {
  ArbL2ToL1HookConfig,
  ArbL2ToL1IsmConfig,
  HyperlaneCore,
  IsmType,
  findMatchingLogEvents,
} from '@hyperlane-xyz/sdk';
import { WithAddress, assert, rootLogger } from '@hyperlane-xyz/utils';

import type {
  ArbL2ToL1MetadataBuildResult,
  MetadataBuilder,
  MetadataContext,
} from './types.js';

export type ArbL2ToL1Metadata = {
  proof: Hex[]; // bytes32[16]
  position: bigint;
  caller: Hex;
  destination: Hex;
  arbBlockNum: bigint;
  ethBlockNum: bigint;
  timestamp: bigint;
  callvalue: bigint;
  data: Hex;
};

const ARB_L2_TO_L1_METADATA_TYPES = parseAbiParameters(
  'bytes32[] proof, uint256 position, address caller, address destination, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data',
);

const ARB_L2_TO_L1_METADATA_NO_CALLVALUE_TYPES = parseAbiParameters(
  'bytes32[] proof, uint256 position, address caller, address destination, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, bytes data',
);

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') return BigInt(value);
  if (value && typeof value === 'object' && 'toString' in value) {
    return BigInt((value as { toString: () => string }).toString());
  }
  throw new Error(`Cannot convert value to bigint: ${String(value)}`);
}

type L2ToL1TxArgs = {
  caller: string;
  destination: string;
  hash: Hex;
  position: unknown;
  arbBlockNum: unknown;
  ethBlockNum: unknown;
  timestamp: unknown;
  callvalue: unknown;
  data: Hex;
};

function parseL2ToL1TxArgs(args: unknown): L2ToL1TxArgs {
  if (Array.isArray(args)) {
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
    ] = args as unknown[];
    return {
      caller: String(caller),
      destination: String(destination),
      hash: String(hash) as Hex,
      position,
      arbBlockNum,
      ethBlockNum,
      timestamp,
      callvalue,
      data: String(data) as Hex,
    };
  }

  assert(args && typeof args === 'object', 'Invalid L2ToL1Tx event args');
  const objArgs = args as Record<string, unknown>;
  return {
    caller: String(objArgs.caller),
    destination: String(objArgs.destination),
    hash: String(objArgs.hash) as Hex,
    position: objArgs.position,
    arbBlockNum: objArgs.arbBlockNum,
    ethBlockNum: objArgs.ethBlockNum,
    timestamp: objArgs.timestamp,
    callvalue: objArgs.callvalue,
    data: String(objArgs.data) as Hex,
  };
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
  ): Promise<ArbL2ToL1MetadataBuildResult> {
    assert(context.ism.type === IsmType.ARB_L2_TO_L1, 'Invalid ISM type');
    this.logger.debug({ context }, 'Building ArbL2ToL1 metadata');

    const baseResult: Omit<ArbL2ToL1MetadataBuildResult, 'bridgeStatus'> = {
      type: IsmType.ARB_L2_TO_L1,
      ismAddress: context.ism.address,
    };

    // if the executeTransaction call is already successful, we can call with null metadata
    const ism = AbstractMessageIdAuthorizedIsm__factory.connect(
      context.ism.address,
      this.core.multiProvider.getSigner(context.message.parsed.destination),
    );
    const verified = await ism.isVerified(context.message.message);
    if (verified) {
      this.logger.debug(
        'Message is already verified, relaying without metadata...',
      );
      return {
        ...baseResult,
        bridgeStatus: 'verified',
        metadata: '0x',
      };
    }

    // else build the metadata for outbox.executeTransaction call
    try {
      const arbMetadata = await this.buildArbitrumBridgeCalldata(context);
      return {
        ...baseResult,
        bridgeStatus: 'confirmed',
        metadata: ArbL2ToL1MetadataBuilder.encodeArbL2ToL1Metadata(arbMetadata),
      };
    } catch (error: any) {
      // Parse the error to determine bridge status
      const errorMessage = error?.message ?? String(error);

      if (errorMessage.includes('Wait') && errorMessage.includes('blocks')) {
        // Extract blocks remaining from error message
        // Note: This parsing depends on error format from buildArbitrumBridgeCalldata
        // e.g., "Wait 123 blocks until the challenge period..."
        const blocksMatch = errorMessage.match(/Wait (\d+) blocks/);
        const blocksRemaining = blocksMatch
          ? parseInt(blocksMatch[1], 10)
          : undefined;
        return {
          ...baseResult,
          bridgeStatus: 'unconfirmed',
          blocksRemaining,
        };
      }

      if (errorMessage.includes('already been executed')) {
        return {
          ...baseResult,
          bridgeStatus: 'executed',
        };
      }

      // Re-throw unknown errors
      throw error;
    }
  }

  async buildArbitrumBridgeCalldata(
    context: MetadataContext<
      WithAddress<ArbL2ToL1IsmConfig>,
      WithAddress<ArbL2ToL1HookConfig>
    >,
  ): Promise<ArbL2ToL1Metadata> {
    const matchingL2TxEvent = (
      findMatchingLogEvents(
        context.dispatchTx.logs,
        ArbSys,
        'L2ToL1Tx',
      ) as any[]
    ).find((log: any) => {
      const calldata = Array.isArray(log.args)
        ? String(log.args[8] ?? '')
        : String(log.args?.data ?? '');
      const messageIdHex = context.message.id.slice(2);
      return calldata && calldata.includes(messageIdHex);
    });

    assert(matchingL2TxEvent, 'No matching L2ToL1Tx event found');
    this.logger.debug({ matchingL2TxEvent }, 'Found matching L2ToL1Tx event');

    if (matchingL2TxEvent) {
      const {
        caller,
        destination,
        hash,
        position,
        arbBlockNum,
        ethBlockNum,
        timestamp,
        callvalue,
        data,
      } = parseL2ToL1TxArgs(matchingL2TxEvent.args);
      const l2ToL1TxEvent = {
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
        l2ToL1TxEvent as unknown as ChildToParentTransactionEvent,
      );

      const originChainMetadata = this.core.multiProvider.getChainMetadata(
        context.message.parsed.origin,
      );
      if (typeof originChainMetadata.chainId == 'string') {
        throw new Error(
          `Invalid chainId for ${originChainMetadata.name}: ${originChainMetadata.chainId}`,
        );
      }
      const baseProvider = this.core.multiProvider.getProvider(
        context.message.parsed.origin,
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
        caller: caller as Hex,
        destination: destination as Hex,
        position: toBigInt(position),
        arbBlockNum: toBigInt(arbBlockNum),
        ethBlockNum: toBigInt(ethBlockNum),
        timestamp: toBigInt(timestamp),
        callvalue: toBigInt(callvalue),
        data: data as Hex,
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
  ): Promise<bigint> {
    const firstBlock = await reader.getFirstExecutableBlock(provider);
    if (!firstBlock) {
      throw new Error('No first executable block found');
    }
    const firstBlockBigInt = toBigInt(firstBlock);
    const currentBlock = BigInt(await provider.getBlockNumber());
    if (currentBlock > firstBlockBigInt) {
      throw new Error('First executable block is in the past');
    }
    const waitingPeriod = firstBlockBigInt - currentBlock;

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
  ): Promise<`0x${string}`[]> {
    const proof = (await reader.getOutboxProof(provider)) ?? [];
    if (!proof) {
      throw new Error('No outbox proof found');
    }
    return ('proof' in proof ? proof.proof : proof) as `0x${string}`[];
  }

  static decode(
    metadata: string,
    _: MetadataContext<WithAddress<ArbL2ToL1IsmConfig>>,
  ): ArbL2ToL1Metadata {
    const [
      proof,
      position,
      caller,
      destination,
      arbBlockNum,
      ethBlockNum,
      timestamp,
      data,
    ] = decodeAbiParameters(
      ARB_L2_TO_L1_METADATA_NO_CALLVALUE_TYPES,
      metadata as Hex,
    );

    return {
      proof,
      position,
      caller,
      destination,
      arbBlockNum,
      ethBlockNum,
      timestamp,
      callvalue: 0n,
      data,
    } as unknown as ArbL2ToL1Metadata;
  }

  static encodeArbL2ToL1Metadata(metadata: ArbL2ToL1Metadata): string {
    return encodeAbiParameters(ARB_L2_TO_L1_METADATA_TYPES, [
      metadata.proof,
      toBigInt(metadata.position),
      metadata.caller as `0x${string}`,
      metadata.destination as `0x${string}`,
      toBigInt(metadata.arbBlockNum),
      toBigInt(metadata.ethBlockNum),
      toBigInt(metadata.timestamp),
      toBigInt(metadata.callvalue),
      metadata.data as `0x${string}`,
    ]);
  }
}
