import type { BedrockCrossChainMessageProof } from '@eth-optimism/core-utils';
import {
  ContractFunctionExecutionError,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  fromRlp,
  http,
  isAddress,
  isHex,
  keccak256,
  parseEventLogs,
  toHex,
  toRlp,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';

const DEFAULT_L2_CROSS_DOMAIN_MESSENGER =
  '0x4200000000000000000000000000000000000007';
const DEFAULT_L2_TO_L1_MESSAGE_PASSER =
  '0x4200000000000000000000000000000000000016';

const L2_CROSS_DOMAIN_MESSENGER_ABI = [
  {
    type: 'event',
    name: 'SentMessage',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'target', type: 'address' },
      { indexed: false, name: 'sender', type: 'address' },
      { indexed: false, name: 'message', type: 'bytes' },
      { indexed: false, name: 'messageNonce', type: 'uint256' },
      { indexed: false, name: 'gasLimit', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'SentMessageExtension1',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ],
  },
] as const;

const L2_TO_L1_MESSAGE_PASSER_ABI = [
  {
    type: 'event',
    name: 'MessagePassed',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'nonce', type: 'uint256' },
      { indexed: true, name: 'sender', type: 'address' },
      { indexed: true, name: 'target', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
      { indexed: false, name: 'gasLimit', type: 'uint256' },
      { indexed: false, name: 'data', type: 'bytes' },
      { indexed: false, name: 'withdrawalHash', type: 'bytes32' },
    ],
  },
] as const;

const L2_OUTPUT_ORACLE_ABI = [
  {
    type: 'function',
    name: 'getL2OutputIndexAfter',
    stateMutability: 'view',
    inputs: [{ name: '_l2BlockNumber', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getL2Output',
    stateMutability: 'view',
    inputs: [{ name: '_l2OutputIndex', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'outputRoot', type: 'bytes32' },
          { name: 'timestamp', type: 'uint128' },
          { name: 'l2BlockNumber', type: 'uint128' },
        ],
      },
    ],
  },
] as const;

const RELAY_MESSAGE_ABI = [
  {
    type: 'function',
    name: 'relayMessage',
    stateMutability: 'payable',
    inputs: [
      { name: '_nonce', type: 'uint256' },
      { name: '_sender', type: 'address' },
      { name: '_target', type: 'address' },
      { name: '_value', type: 'uint256' },
      { name: '_minGasLimit', type: 'uint256' },
      { name: '_message', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

const RELAY_CONSTANT_OVERHEAD = 200_000n;
const RELAY_PER_BYTE_DATA_COST = 16n;
const MIN_GAS_DYNAMIC_OVERHEAD_NUMERATOR = 64n;
const MIN_GAS_DYNAMIC_OVERHEAD_DENOMINATOR = 63n;
const RELAY_CALL_OVERHEAD = 40_000n;
const RELAY_RESERVED_GAS = 40_000n;
const RELAY_GAS_CHECK_BUFFER = 5_000n;
const MAX_MIGRATED_WITHDRAWAL_GAS = 25_000_000n;

type EthGetProofResult = {
  storageHash: Hex;
  storageProof: readonly {
    proof: readonly Hex[];
  }[];
};

type OutputProposal = {
  outputRoot: Hex;
  timestamp: bigint;
  l2BlockNumber: bigint;
};

export type OpStackL2TransactionReceipt = TransactionReceipt;

export type OpStackCoreCrossChainMessage = {
  sender: Address;
  target: Address;
  message: Hex;
  messageNonce: bigint;
  value: bigint;
  minGasLimit: bigint;
};

type OpStackCrossChainMessage = OpStackCoreCrossChainMessage & {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
};

type OpStackMessengerLiteConfig = {
  l1RpcUrl: string;
  l2RpcUrl: string;
  l1CrossDomainMessenger: string;
  l2OutputOracle: string;
  l2ChainId: number;
  l2CrossDomainMessenger?: string;
  l2ToL1MessagePasser?: string;
};

function getHexByteLength(data: Hex): bigint {
  return BigInt((data.length - 2) / 2);
}

function getMessageVersion(messageNonce: bigint): bigint {
  return messageNonce >> 240n;
}

function migratedWithdrawalGasLimit(data: Hex, chainId: number): bigint {
  const dataCost = getHexByteLength(data) * RELAY_PER_BYTE_DATA_COST;
  const overhead =
    chainId === 420
      ? 200_000n
      : RELAY_CONSTANT_OVERHEAD +
        (MIN_GAS_DYNAMIC_OVERHEAD_NUMERATOR * 1_000_000n) /
          MIN_GAS_DYNAMIC_OVERHEAD_DENOMINATOR +
        RELAY_CALL_OVERHEAD +
        RELAY_RESERVED_GAS +
        RELAY_GAS_CHECK_BUFFER;

  const minGasLimit = dataCost + overhead;
  return minGasLimit > MAX_MIGRATED_WITHDRAWAL_GAS
    ? MAX_MIGRATED_WITHDRAWAL_GAS
    : minGasLimit;
}

function hashLowLevelMessage(message: OpStackCoreCrossChainMessage): Hex {
  const encoded = encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'bytes' },
    ],
    [
      message.messageNonce,
      message.sender,
      message.target,
      message.value,
      message.minGasLimit,
      message.message,
    ],
  );
  return keccak256(encoded);
}

function hashMessageHash(messageHash: Hex): Hex {
  const encoded = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }],
    [messageHash, 0n],
  );
  return keccak256(encoded);
}

function encodeCrossDomainMessageV1(
  message: OpStackCoreCrossChainMessage,
): Hex {
  return encodeFunctionData({
    abi: RELAY_MESSAGE_ABI,
    functionName: 'relayMessage',
    args: [
      message.messageNonce,
      message.sender,
      message.target,
      message.value,
      message.minGasLimit,
      message.message,
    ],
  });
}

function maybeAddProofNode(key: Hex, proof: readonly Hex[]): Hex[] {
  if (proof.length === 0) return [...proof];

  const modifiedProof = [...proof];
  const finalProofElement = modifiedProof[modifiedProof.length - 1];
  const finalProofElementDecoded = fromRlp(finalProofElement, 'hex');

  if (
    !Array.isArray(finalProofElementDecoded) ||
    finalProofElementDecoded.length !== 17
  ) {
    return modifiedProof;
  }

  for (const item of finalProofElementDecoded) {
    if (!Array.isArray(item) || item.length === 0) continue;
    const first = item[0];
    if (typeof first !== 'string') continue;

    const suffix = first.slice(3);
    if (key.endsWith(suffix)) {
      modifiedProof.push(toRlp(item, 'hex'));
    }
  }

  return modifiedProof;
}

function isCannotGetOutputError(error: unknown): boolean {
  if (error instanceof ContractFunctionExecutionError) {
    return error.details.includes('cannot get output');
  }
  return error instanceof Error && error.message.includes('cannot get output');
}

function parseAddress(value: string, label: string): Address {
  if (!isAddress(value)) {
    throw new Error(`Invalid ${label} address: ${value}`);
  }
  return value;
}

function parseOutputProposal(value: unknown): OutputProposal {
  if (Array.isArray(value)) {
    if (
      value.length === 3 &&
      isHex(value[0]) &&
      typeof value[1] === 'bigint' &&
      typeof value[2] === 'bigint'
    ) {
      return {
        outputRoot: value[0],
        timestamp: value[1],
        l2BlockNumber: value[2],
      };
    }

    if (value.length === 1) {
      return parseOutputProposal(value[0]);
    }
  }

  if (typeof value === 'object' && value !== null) {
    const outputRoot = Reflect.get(value, 'outputRoot');
    const timestamp = Reflect.get(value, 'timestamp');
    const l2BlockNumber = Reflect.get(value, 'l2BlockNumber');

    if (
      isHex(outputRoot) &&
      typeof timestamp === 'bigint' &&
      typeof l2BlockNumber === 'bigint'
    ) {
      return { outputRoot, timestamp, l2BlockNumber };
    }
  }

  throw new Error('Invalid L2OutputOracle.getL2Output response');
}

function parseStorageProof(value: unknown): EthGetProofResult['storageProof'] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid storageProof in eth_getProof response');
  }

  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Invalid storageProof entry in eth_getProof response');
    }

    const proofValue = Reflect.get(entry, 'proof');
    if (!Array.isArray(proofValue) || proofValue.some((item) => !isHex(item))) {
      throw new Error('Invalid storage proof nodes in eth_getProof response');
    }

    return {
      proof: proofValue,
    };
  });
}

function parseEthGetProofResult(value: unknown): EthGetProofResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid eth_getProof response');
  }

  const storageHash = Reflect.get(value, 'storageHash');
  if (!isHex(storageHash)) {
    throw new Error('Invalid storageHash in eth_getProof response');
  }

  const storageProof = parseStorageProof(Reflect.get(value, 'storageProof'));
  return { storageHash, storageProof };
}

export class OpStackMessengerLite {
  private readonly l1Client: PublicClient;
  private readonly l2Client: PublicClient;
  private readonly l1CrossDomainMessenger: Address;
  private readonly l2CrossDomainMessenger: Address;
  private readonly l2ToL1MessagePasser: Address;
  private readonly l2OutputOracle: Address;
  private readonly l2ChainId: number;

  constructor(config: OpStackMessengerLiteConfig) {
    this.l1Client = createPublicClient({
      transport: http(config.l1RpcUrl),
    });
    this.l2Client = createPublicClient({
      transport: http(config.l2RpcUrl),
    });

    this.l1CrossDomainMessenger = parseAddress(
      config.l1CrossDomainMessenger,
      'L1_CROSS_DOMAIN_MESSENGER',
    );
    this.l2OutputOracle = parseAddress(
      config.l2OutputOracle,
      'L2_OUTPUT_ORACLE',
    );
    this.l2ChainId = config.l2ChainId;

    this.l2CrossDomainMessenger = parseAddress(
      config.l2CrossDomainMessenger ?? DEFAULT_L2_CROSS_DOMAIN_MESSENGER,
      'L2_CROSS_DOMAIN_MESSENGER',
    );
    this.l2ToL1MessagePasser = parseAddress(
      config.l2ToL1MessagePasser ?? DEFAULT_L2_TO_L1_MESSAGE_PASSER,
      'L2_TO_L1_MESSAGE_PASSER',
    );
  }

  async getL2TransactionReceipt(
    txHash: Hex,
  ): Promise<OpStackL2TransactionReceipt> {
    return this.l2Client.getTransactionReceipt({ hash: txHash });
  }

  async toCrossChainMessage(
    receipt: OpStackL2TransactionReceipt,
    messageIndex = 0,
  ): Promise<OpStackCrossChainMessage> {
    const messengerLogs = receipt.logs.filter(
      (log) =>
        log.address.toLowerCase() === this.l2CrossDomainMessenger.toLowerCase(),
    );

    const extensions = parseEventLogs({
      abi: L2_CROSS_DOMAIN_MESSENGER_ABI,
      eventName: 'SentMessageExtension1',
      logs: messengerLogs,
      strict: false,
    });

    const extensionValueByLogIndex = new Map<number, bigint>();
    for (const extension of extensions) {
      if (extension.logIndex == null || extension.args.value == null) continue;
      extensionValueByLogIndex.set(extension.logIndex, extension.args.value);
    }

    const sentMessages = parseEventLogs({
      abi: L2_CROSS_DOMAIN_MESSENGER_ABI,
      eventName: 'SentMessage',
      logs: messengerLogs,
      strict: false,
    }).map((messageLog) => {
      const logIndex = messageLog.logIndex;
      if (logIndex == null) {
        throw new Error('Missing logIndex for SentMessage log');
      }
      if (
        messageLog.args.target == null ||
        messageLog.args.sender == null ||
        messageLog.args.message == null ||
        messageLog.args.messageNonce == null ||
        messageLog.args.gasLimit == null
      ) {
        throw new Error('Incomplete SentMessage event args');
      }

      const txHash = messageLog.transactionHash ?? receipt.transactionHash;
      if (!txHash) {
        throw new Error('Missing transaction hash for SentMessage log');
      }

      return {
        sender: messageLog.args.sender,
        target: messageLog.args.target,
        message: messageLog.args.message,
        messageNonce: messageLog.args.messageNonce,
        value: extensionValueByLogIndex.get(logIndex + 1) ?? 0n,
        minGasLimit: messageLog.args.gasLimit,
        blockNumber: messageLog.blockNumber ?? receipt.blockNumber,
        logIndex,
        transactionHash: txHash,
      };
    });

    if (sentMessages.length === 0) {
      throw new Error('No SentMessage events found in receipt');
    }

    const message = sentMessages[messageIndex];
    if (!message) {
      throw new Error(
        `Withdrawal index ${messageIndex} out of bounds. There are ${sentMessages.length} withdrawals`,
      );
    }

    return message;
  }

  async toLowLevelMessage(
    message: OpStackCrossChainMessage,
    messageIndex = 0,
  ): Promise<OpStackCoreCrossChainMessage> {
    const messageVersion = getMessageVersion(message.messageNonce);

    const encoded = encodeCrossDomainMessageV1(message);

    let withdrawalNonce: bigint;
    let withdrawalGasLimit: bigint;

    if (messageVersion === 0n) {
      withdrawalNonce = message.messageNonce;
      withdrawalGasLimit = migratedWithdrawalGasLimit(encoded, this.l2ChainId);
    } else {
      const receipt = await this.getL2TransactionReceipt(
        message.transactionHash,
      );
      const withdrawals = parseEventLogs({
        abi: L2_TO_L1_MESSAGE_PASSER_ABI,
        eventName: 'MessagePassed',
        logs: receipt.logs.filter(
          (log) =>
            log.address.toLowerCase() ===
            this.l2ToL1MessagePasser.toLowerCase(),
        ),
        strict: false,
      });

      if (withdrawals.length === 0) {
        throw new Error('No MessagePassed events found in receipt');
      }

      const withdrawal = withdrawals[messageIndex];
      if (!withdrawal) {
        throw new Error(
          `Withdrawal index ${messageIndex} out of bounds. There are ${withdrawals.length} withdrawals`,
        );
      }

      if (withdrawal.args.nonce == null || withdrawal.args.gasLimit == null) {
        throw new Error('Incomplete MessagePassed event args');
      }

      withdrawalNonce = withdrawal.args.nonce;
      withdrawalGasLimit = withdrawal.args.gasLimit;
    }

    return {
      messageNonce: withdrawalNonce,
      sender: this.l2CrossDomainMessenger,
      target: this.l1CrossDomainMessenger,
      value: message.value,
      minGasLimit: withdrawalGasLimit,
      message: encoded,
    };
  }

  async getBedrockMessageProof(
    message: OpStackCrossChainMessage,
    messageIndex = 0,
  ): Promise<BedrockCrossChainMessageProof> {
    const output = await this.getMessageBedrockOutput(message);
    const withdrawal = await this.toLowLevelMessage(message, messageIndex);
    const hash = hashLowLevelMessage(withdrawal);
    const messageSlot = hashMessageHash(hash);

    const stateTrieProof = await this.makeStateTrieProof(
      output.l2BlockNumber,
      this.l2ToL1MessagePasser,
      messageSlot,
    );

    const block = await this.l2Client.getBlock({
      blockNumber: output.l2BlockNumber,
    });

    if (!block.hash) {
      throw new Error('Block hash unavailable for output block');
    }

    return {
      outputRootProof: {
        version:
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        stateRoot: block.stateRoot,
        messagePasserStorageRoot: stateTrieProof.storageRoot,
        latestBlockhash: block.hash,
      },
      withdrawalProof: stateTrieProof.storageProof,
      l2OutputIndex: Number(output.l2OutputIndex),
    };
  }

  private async getMessageBedrockOutput(
    message: OpStackCrossChainMessage,
  ): Promise<{
    l2BlockNumber: bigint;
    l2OutputIndex: bigint;
  }> {
    let l2OutputIndex: bigint;
    try {
      l2OutputIndex = await this.l1Client.readContract({
        address: this.l2OutputOracle,
        abi: L2_OUTPUT_ORACLE_ABI,
        functionName: 'getL2OutputIndexAfter',
        args: [message.blockNumber],
      });
    } catch (error) {
      if (isCannotGetOutputError(error)) {
        throw new Error('State root for message not yet published');
      }
      throw error;
    }

    const proposalRaw = await this.l1Client.readContract({
      address: this.l2OutputOracle,
      abi: L2_OUTPUT_ORACLE_ABI,
      functionName: 'getL2Output',
      args: [l2OutputIndex],
    });
    const proposal = parseOutputProposal(proposalRaw);

    return {
      l2BlockNumber: proposal.l2BlockNumber,
      l2OutputIndex,
    };
  }

  private async makeStateTrieProof(
    blockNumber: bigint,
    address: Address,
    slot: Hex,
  ): Promise<{
    storageProof: Hex[];
    storageRoot: Hex;
  }> {
    const proof = parseEthGetProofResult(
      await this.l2Client.request({
        method: 'eth_getProof',
        params: [address, [slot], toHex(blockNumber)],
      }),
    );

    const storageProofEntry = proof.storageProof[0];
    if (!storageProofEntry) {
      throw new Error('No storage proof found in eth_getProof response');
    }

    return {
      storageProof: maybeAddProofNode(keccak256(slot), storageProofEntry.proof),
      storageRoot: proof.storageHash,
    };
  }
}
