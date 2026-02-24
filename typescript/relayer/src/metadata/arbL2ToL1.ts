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
import {
  WithAddress,
  assert,
  rootLogger,
  toBigInt,
} from '@hyperlane-xyz/utils';

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isHexString(value: string): value is Hex {
  return value.startsWith('0x');
}

function toHex(value: unknown, field: string): Hex {
  assert(
    typeof value === 'string' && isHexString(value),
    `Invalid ${field} value: ${String(value)}`,
  );
  return value;
}

type ArbitrumBigNumberish = {
  toHexString: () => string;
  toNumber: () => number;
  toString: () => string;
};
type LogLike = { data: string; topics: readonly string[] };

type ChildToParentReaderProvider = ConstructorParameters<
  typeof ChildToParentMessageReader
>[0];
type ArbitrumBaseProvider = ConstructorParameters<typeof ArbitrumProvider>[0];

function toChildToParentReaderProvider(
  provider: unknown,
): ChildToParentReaderProvider {
  const candidate = provider as Record<string, unknown> | undefined;
  assert(
    !!candidate &&
      typeof candidate.getBlockNumber === 'function' &&
      typeof candidate.getNetwork === 'function',
    'Destination provider does not satisfy ChildToParentMessageReader requirements',
  );
  return provider as ChildToParentReaderProvider;
}

function toArbitrumBaseProvider(provider: unknown): ArbitrumBaseProvider {
  const candidate = provider as Record<string, unknown> | undefined;
  assert(
    !!candidate &&
      typeof candidate.send === 'function' &&
      typeof candidate.getNetwork === 'function',
    'Origin provider does not satisfy ArbitrumProvider requirements',
  );
  return provider as ArbitrumBaseProvider;
}

function isLogLike(value: unknown): value is LogLike {
  const record = asRecord(value);
  if (!record) return false;

  const topics = record.topics;
  return (
    typeof record.data === 'string' &&
    Array.isArray(topics) &&
    topics.every((topic) => typeof topic === 'string')
  );
}

function toReaderNumeric(value: unknown): ArbitrumBigNumberish {
  const numeric = toBigInt(value);
  return {
    toHexString: () => `0x${numeric.toString(16)}`,
    toNumber: () => Number(numeric),
    toString: () => numeric.toString(),
  };
}

type L2ToL1TxArgs = {
  caller: string;
  destination: string;
  hash: ArbitrumBigNumberish;
  position: ArbitrumBigNumberish;
  arbBlockNum: ArbitrumBigNumberish;
  ethBlockNum: ArbitrumBigNumberish;
  timestamp: ArbitrumBigNumberish;
  callvalue: ArbitrumBigNumberish;
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
    ] = args;
    return {
      caller: String(caller),
      destination: String(destination),
      hash: toReaderNumeric(hash),
      position: toReaderNumeric(position),
      arbBlockNum: toReaderNumeric(arbBlockNum),
      ethBlockNum: toReaderNumeric(ethBlockNum),
      timestamp: toReaderNumeric(timestamp),
      callvalue: toReaderNumeric(callvalue),
      data: toHex(data, 'data'),
    };
  }

  const objArgs = asRecord(args);
  assert(objArgs, 'Invalid L2ToL1Tx event args');
  return {
    caller: String(objArgs.caller),
    destination: String(objArgs.destination),
    hash: toReaderNumeric(objArgs.hash),
    position: toReaderNumeric(objArgs.position),
    arbBlockNum: toReaderNumeric(objArgs.arbBlockNum),
    ethBlockNum: toReaderNumeric(objArgs.ethBlockNum),
    timestamp: toReaderNumeric(objArgs.timestamp),
    callvalue: toReaderNumeric(objArgs.callvalue),
    data: toHex(objArgs.data, 'data'),
  };
}

function toChildToParentTransactionEvent(
  args: L2ToL1TxArgs,
): ChildToParentTransactionEvent {
  return { ...args } as ChildToParentTransactionEvent;
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
    } catch (error: unknown) {
      // Parse the error to determine bridge status
      const errorMessage =
        error && typeof error === 'object' && 'message' in error
          ? String(error.message)
          : String(error);

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
    const rawDispatchLogs = context.dispatchTx.logs;
    assert(
      rawDispatchLogs,
      `No logs found in dispatch tx for message ${context.message.id}`,
    );
    const parsedLogs = Array.from(rawDispatchLogs).filter(isLogLike);
    const matchingL2TxEvent = findMatchingLogEvents(
      parsedLogs,
      ArbSys,
      'L2ToL1Tx',
    ).find((log) => {
      const logArgs = asRecord(log)?.args;
      const calldata = Array.isArray(logArgs)
        ? String(logArgs[8] ?? '')
        : String(asRecord(logArgs)?.data ?? '');
      const messageIdHex = context.message.id.slice(2);
      return calldata && calldata.includes(messageIdHex);
    });

    assert(matchingL2TxEvent, 'No matching L2ToL1Tx event found');
    this.logger.debug({ matchingL2TxEvent }, 'Found matching L2ToL1Tx event');

    if (matchingL2TxEvent) {
      const eventArgs = asRecord(matchingL2TxEvent)?.args;
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
      } = parseL2ToL1TxArgs(eventArgs);
      const l2ToL1TxEvent = toChildToParentTransactionEvent({
        caller,
        destination,
        hash,
        position,
        arbBlockNum,
        ethBlockNum,
        timestamp,
        callvalue,
        data,
      });

      const reader = new ChildToParentMessageReader(
        toChildToParentReaderProvider(
          this.core.multiProvider.getProvider(context.hook.destinationChain),
        ),
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
      const baseProvider = this.core.multiProvider.getProvider(
        context.message.parsed.origin,
      );
      const arbProvider = new ArbitrumProvider(
        toArbitrumBaseProvider(baseProvider),
        {
          name: originChainMetadata.name,
          chainId: originChainMetadata.chainId,
        },
      );

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
        caller: toHex(caller, 'caller'),
        destination: toHex(destination, 'destination'),
        position: toBigInt(position),
        arbBlockNum: toBigInt(arbBlockNum),
        ethBlockNum: toBigInt(ethBlockNum),
        timestamp: toBigInt(timestamp),
        callvalue: toBigInt(callvalue),
        data,
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
    const proof = await reader.getOutboxProof(provider);
    if (!proof) {
      throw new Error('No outbox proof found');
    }
    const rawProof = Array.isArray(proof) ? proof : proof.proof;
    return rawProof.map((value, index) => toHex(value, `proof[${index}]`));
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
      toHex(metadata, 'metadata'),
    );

    return {
      proof: proof.map((item, index) => toHex(item, `proof[${index}]`)),
      position,
      caller: toHex(caller, 'caller'),
      destination: toHex(destination, 'destination'),
      arbBlockNum,
      ethBlockNum,
      timestamp,
      callvalue: 0n,
      data: toHex(data, 'data'),
    };
  }

  static encodeArbL2ToL1Metadata(metadata: ArbL2ToL1Metadata): string {
    return encodeAbiParameters(ARB_L2_TO_L1_METADATA_TYPES, [
      metadata.proof,
      toBigInt(metadata.position),
      metadata.caller,
      metadata.destination,
      toBigInt(metadata.arbBlockNum),
      toBigInt(metadata.ethBlockNum),
      toBigInt(metadata.timestamp),
      toBigInt(metadata.callvalue),
      metadata.data,
    ]);
  }
}
