import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber, ethers } from 'ethers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pino } from 'pino';
import sinon from 'sinon';

import { ERC20__factory } from '@hyperlane-xyz/core';
import { MultiProvider, type SendTransactionOptions } from '@hyperlane-xyz/sdk';
import { TransactionSubmissionError } from '@hyperlane-xyz/utils';

import {
  ArbitrumOrbitBridgeMode,
  BridgeStack,
  ChainConfigSchema,
  HyperlaneHookBridgeDeliverySchema,
  KeyFunderConfigSchema,
  OpStackBridgeMode,
  type KeyFunderConfig,
} from '../config/types.js';
import { KeyFunderMetrics } from '../metrics/Metrics.js';

import {
  ARB_RETRYABLE_TX_ADDRESS,
  BridgeDeliveryKind,
  computeOpStackDepositTxHash,
  DELIVERY_EVENT_INTERFACES,
} from './BridgeDelivery.js';
import {
  BRIDGE_INTERFACES,
  formatStandardHookMetadata,
} from './BridgeFunder.js';
import { FileBridgeStateStore } from './BridgeStateStore.js';
import { KeyFunder } from './KeyFunder.js';

chai.use(chaiAsPromised);

const RELAYER_ADDR = '0x1111111111111111111111111111111111111111';
const VALIDATOR_ADDR = '0x1212121212121212121212121212121212121212';
const FUNDER_ADDR = '0x2222222222222222222222222222222222222222';
const PORTAL_ADDR = '0x3333333333333333333333333333333333333333';
const L1_BRIDGE_ADDR = '0x4444444444444444444444444444444444444444';
const INBOX_ADDR = '0x5555555555555555555555555555555555555555';
const ERC20_BRIDGE_ADDR = '0x5656565656565656565656565656565656565656';
const MAILBOX_ADDR = '0x6666666666666666666666666666666666666666';
const HOOK_ADDR = '0x7777777777777777777777777777777777777777';
const GAS_TOKEN_ADDR = '0x8888888888888888888888888888888888888888';
const FORWARDER_ADDR = '0x9999999999999999999999999999999999999999';
const MOCK_CONTRACT_CODE = '0x6001600055';
const MOCK_BLOCK_HASH = `0x${'aa'.repeat(32)}`;

function buildBlock(
  overrides: Partial<ethers.providers.Block> = {},
): ethers.providers.Block {
  return {
    hash: MOCK_BLOCK_HASH,
    parentHash: ethers.constants.HashZero,
    number: 200,
    timestamp: 2_000,
    nonce: '0x0000000000000000',
    difficulty: 0,
    _difficulty: BigNumber.from(0),
    gasLimit: BigNumber.from(30_000_000),
    gasUsed: BigNumber.from(0),
    miner: ethers.constants.AddressZero,
    extraData: '0x',
    transactions: [],
    ...overrides,
  };
}

function buildContractReceipt(
  overrides: Partial<ethers.ContractReceipt> = {},
): ethers.ContractReceipt {
  return {
    to: PORTAL_ADDR,
    from: FUNDER_ADDR,
    contractAddress: ethers.constants.AddressZero,
    transactionIndex: 0,
    gasUsed: BigNumber.from(100_000),
    logsBloom: '0x',
    blockHash: MOCK_BLOCK_HASH,
    transactionHash: `0x${'ab'.repeat(32)}`,
    logs: [],
    blockNumber: 100,
    confirmations: 1,
    cumulativeGasUsed: BigNumber.from(100_000),
    effectiveGasPrice: BigNumber.from(1_000_000_000),
    byzantium: true,
    type: 2,
    status: 1,
    events: [],
    ...overrides,
  };
}

function buildOpStackDepositLog(params: {
  from?: string;
  to?: string;
  mint?: BigNumber;
  value?: BigNumber;
  gasLimit?: number;
  blockHash?: string;
  logIndex?: number;
}): { log: ethers.providers.Log; l2TxHash: string } {
  const from = params.from ?? FUNDER_ADDR;
  const to = params.to ?? RELAYER_ADDR;
  const mint = params.mint ?? ethers.utils.parseEther('0.5');
  const value = params.value ?? mint;
  const gasLimit = params.gasLimit ?? 200_000;
  const blockHash = params.blockHash ?? MOCK_BLOCK_HASH;
  const logIndex = params.logIndex ?? 0;

  const opaqueData = ethers.utils.solidityPack(
    ['uint256', 'uint256', 'uint64', 'uint8', 'bytes'],
    [mint, value, gasLimit, 0, '0x'],
  );
  const encoded = DELIVERY_EVENT_INTERFACES.opStackPortal.encodeEventLog(
    DELIVERY_EVENT_INTERFACES.opStackPortal.getEvent('TransactionDeposited'),
    [from, to, BigNumber.from(0), opaqueData],
  );

  const log: ethers.providers.Log = {
    blockNumber: 100,
    blockHash,
    transactionIndex: 0,
    removed: false,
    address: PORTAL_ADDR,
    data: encoded.data,
    topics: encoded.topics,
    transactionHash: `0x${'77'.repeat(32)}`,
    logIndex,
  };

  const l2TxHash = computeOpStackDepositTxHash({
    l1BlockHash: blockHash,
    l1LogIndex: logIndex,
    from,
    to,
    opaqueData,
  });

  return { log, l2TxHash };
}

function buildArbitrumRetryableLogs(params: {
  sender?: string;
  recipient?: string;
  l2CallValue?: BigNumber;
  l1Value?: BigNumber;
  maxSubmissionFee?: BigNumber;
  gasLimit?: number;
  maxFeePerGas?: BigNumber;
  messageIndex?: number;
}): ethers.providers.Log[] {
  const sender = params.sender ?? FUNDER_ADDR;
  const recipient = params.recipient ?? RELAYER_ADDR;
  const l2CallValue = params.l2CallValue ?? ethers.utils.parseEther('1');
  const maxSubmissionFee =
    params.maxSubmissionFee ?? BigNumber.from('100000000000000');
  const gasLimit = BigNumber.from(params.gasLimit ?? 300_000);
  const maxFeePerGas = params.maxFeePerGas ?? BigNumber.from('1000000000');
  const l1Value =
    params.l1Value ??
    l2CallValue.add(maxSubmissionFee).add(gasLimit.mul(maxFeePerGas));
  const msgIdx = BigNumber.from(params.messageIndex ?? 42);

  const inboxMsgData = ethers.utils.defaultAbiCoder.encode(
    [
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
    ],
    [
      BigNumber.from(recipient),
      l2CallValue,
      l1Value,
      maxSubmissionFee,
      BigNumber.from(sender),
      BigNumber.from(sender),
      gasLimit,
      maxFeePerGas,
      BigNumber.from(0),
    ],
  );

  const inboxEnc = DELIVERY_EVENT_INTERFACES.arbitrumInboxEvents.encodeEventLog(
    DELIVERY_EVENT_INTERFACES.arbitrumInboxEvents.getEvent(
      'InboxMessageDelivered',
    ),
    [msgIdx, inboxMsgData],
  );
  const bridgeEnc = DELIVERY_EVENT_INTERFACES.arbitrumBridge.encodeEventLog(
    DELIVERY_EVENT_INTERFACES.arbitrumBridge.getEvent('MessageDelivered'),
    [
      msgIdx,
      ethers.constants.HashZero,
      INBOX_ADDR,
      9,
      sender,
      ethers.utils.keccak256(inboxMsgData),
      BigNumber.from(1_000_000_000),
      1_700_000_000,
    ],
  );

  return [
    {
      blockNumber: 100,
      blockHash: MOCK_BLOCK_HASH,
      transactionIndex: 0,
      removed: false,
      address: INBOX_ADDR,
      data: inboxEnc.data,
      topics: inboxEnc.topics,
      transactionHash: `0x${'88'.repeat(32)}`,
      logIndex: 0,
    },
    {
      blockNumber: 100,
      blockHash: MOCK_BLOCK_HASH,
      transactionIndex: 0,
      removed: false,
      address: ERC20_BRIDGE_ADDR,
      data: bridgeEnc.data,
      topics: bridgeEnc.topics,
      transactionHash: `0x${'88'.repeat(32)}`,
      logIndex: 1,
    },
  ];
}

async function extractTxCallData(
  tx: ethers.utils.Deferrable<ethers.providers.TransactionRequest>,
): Promise<string> {
  const raw = await tx.data;
  if (typeof raw === 'string') {
    return raw;
  }
  return raw != null ? ethers.utils.hexlify(raw) : '0x';
}

async function buildPopulatedTx(
  tx: ethers.utils.Deferrable<ethers.providers.TransactionRequest>,
  defaultGasLimit: BigNumber,
  defaultMaxFeePerGas: BigNumber,
  defaultNonce = 7,
): Promise<ethers.providers.TransactionRequest> {
  const [to, data, value, gasLimit, maxFeePerGas, nonce] = await Promise.all([
    tx.to,
    tx.data,
    tx.value,
    tx.gasLimit,
    tx.maxFeePerGas,
    tx.nonce,
  ]);
  return {
    to,
    from: FUNDER_ADDR,
    data,
    nonce: nonce ?? defaultNonce,
    value: value != null ? BigNumber.from(value) : undefined,
    gasLimit: gasLimit != null ? BigNumber.from(gasLimit) : defaultGasLimit,
    maxFeePerGas:
      maxFeePerGas != null ? BigNumber.from(maxFeePerGas) : defaultMaxFeePerGas,
  };
}

function createMockSetup(params?: {
  destFunderBalance?: BigNumber;
  destRoleBalance?: BigNumber;
  originFunderBalance?: BigNumber;
  originGasLimit?: BigNumber;
  originMaxFeePerGas?: BigNumber;
  originNonce?: number;
  originCode?: string;
  destCode?: string;
  destDomainId?: number;
  destNativeDecimals?: number;
}) {
  const destProvider = sinon.createStubInstance(
    ethers.providers.JsonRpcProvider,
  );
  destProvider.getBalance.resolves(
    params?.destRoleBalance ?? BigNumber.from(0),
  );
  destProvider.getCode.resolves(params?.destCode ?? MOCK_CONTRACT_CODE);

  const originProvider = sinon.createStubInstance(
    ethers.providers.JsonRpcProvider,
  );
  originProvider.getCode.resolves(params?.originCode ?? MOCK_CONTRACT_CODE);
  originProvider.getGasPrice.resolves(
    params?.originMaxFeePerGas ?? BigNumber.from(1_000_000_000),
  );

  const destSigner = sinon.createStubInstance(ethers.Wallet);
  destSigner.getAddress.resolves(FUNDER_ADDR);
  destSigner.getBalance.resolves(
    params?.destFunderBalance ?? BigNumber.from(0),
  );

  const originGasLimit = params?.originGasLimit ?? BigNumber.from(100_000);
  const originMaxFeePerGas =
    params?.originMaxFeePerGas ?? BigNumber.from(1_000_000_000);
  const originNonce = params?.originNonce ?? 7;

  const originSigner = sinon.createStubInstance(ethers.Wallet);
  originSigner.getAddress.resolves(FUNDER_ADDR);
  originSigner.getBalance.resolves(
    params?.originFunderBalance ?? ethers.utils.parseEther('10'),
  );
  originSigner.getTransactionCount.resolves(originNonce);
  originSigner.populateTransaction.callsFake(async (tx) =>
    buildPopulatedTx(tx, originGasLimit, originMaxFeePerGas, originNonce),
  );

  const multiProvider = sinon.createStubInstance(MultiProvider);
  multiProvider.getProvider.callsFake((chain) =>
    chain === 'ethereum' ? originProvider : destProvider,
  );
  multiProvider.getSigner.callsFake((chain) =>
    chain === 'ethereum' ? originSigner : destSigner,
  );
  multiProvider.getSignerAddress.resolves(FUNDER_ADDR);
  multiProvider.getChainMetadata.callsFake((chain) =>
    chain === 'ethereum'
      ? {
          chainId: 1,
          domainId: 1,
          blocks: { confirmations: 1, reorgPeriod: 32 },
          nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        }
      : {
          chainId: params?.destDomainId ?? 8453,
          domainId: params?.destDomainId ?? 8453,
          blocks: { confirmations: 1, reorgPeriod: 0 },
          nativeToken: {
            name: 'Ether',
            symbol: 'ETH',
            decimals: params?.destNativeDecimals ?? 18,
          },
        },
  );
  multiProvider.prepareTx.callsFake(async (_chain, transaction) => transaction);
  multiProvider.estimateGas.resolves(originGasLimit);

  const sendTransaction = sinon.stub<
    Parameters<MultiProvider['sendTransaction']>,
    ReturnType<MultiProvider['sendTransaction']>
  >();
  sendTransaction.callsFake(
    async (_chain, _tx, options?: SendTransactionOptions) => {
      const hash = `0x${'ab'.repeat(32)}`;
      await options?.onSubmissionAttempt?.(hash);
      await options?.onSubmitted?.(hash);
      return buildContractReceipt({ transactionHash: hash });
    },
  );
  multiProvider.sendTransaction = sendTransaction;
  multiProvider.tryGetExplorerTxUrl.returns(null);

  return {
    multiProvider,
    sendTransaction,
    originProvider,
    destProvider,
    originSigner,
    destSigner,
  };
}

function stubErc20InboxOriginCalls(params: {
  originProvider: ethers.providers.JsonRpcProvider;
  tokenAddress?: string;
  bridgeNativeToken?: string;
  bridgeDecimals: number;
  tokenDecimals?: number;
  tokenBalance: BigNumber;
  allowance: BigNumber;
}) {
  const tokenInterface = ERC20__factory.createInterface();
  const bridgeNativeToken =
    params.bridgeNativeToken ?? params.tokenAddress ?? GAS_TOKEN_ADDR;
  const tokenDecimals = params.tokenDecimals ?? params.bridgeDecimals;

  sinon.stub(params.originProvider, 'call').callsFake(async (tx) => {
    const to = (await tx.to)?.toLowerCase();
    const data = await extractTxCallData(tx);

    if (to === INBOX_ADDR.toLowerCase()) {
      const parsed = BRIDGE_INTERFACES.arbitrumErc20Inbox.parseTransaction({
        data,
      });
      if (parsed.name === 'bridge') {
        return BRIDGE_INTERFACES.arbitrumErc20Inbox.encodeFunctionResult(
          'bridge',
          [ERC20_BRIDGE_ADDR],
        );
      }
    }

    if (to === ERC20_BRIDGE_ADDR.toLowerCase()) {
      const parsed = BRIDGE_INTERFACES.arbitrumErc20Bridge.parseTransaction({
        data,
      });
      if (parsed.name === 'nativeToken') {
        return BRIDGE_INTERFACES.arbitrumErc20Bridge.encodeFunctionResult(
          'nativeToken',
          [bridgeNativeToken],
        );
      }
      if (parsed.name === 'nativeTokenDecimals') {
        return BRIDGE_INTERFACES.arbitrumErc20Bridge.encodeFunctionResult(
          'nativeTokenDecimals',
          [params.bridgeDecimals],
        );
      }
    }

    const { name } = tokenInterface.parseTransaction({ data });
    if (name === 'decimals') {
      return tokenInterface.encodeFunctionResult('decimals', [tokenDecimals]);
    }
    if (name === 'balanceOf') {
      return tokenInterface.encodeFunctionResult('balanceOf', [
        params.tokenBalance,
      ]);
    }
    if (name === 'allowance') {
      return tokenInterface.encodeFunctionResult('allowance', [
        params.allowance,
      ]);
    }
    throw new Error(`Unexpected origin call: ${name}`);
  });
}

describe('KeyFunder OP Stack and Arbitrum Orbit bridges', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('Schema validation', () => {
    it('rejects OP Stack canonical mode without bridgeContract', () => {
      const parsed = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'opStack',
          originChain: 'ethereum',
          mode: 'optimismPortal',
        },
      });
      expect(parsed.success).to.equal(false);
    });

    it('rejects Arbitrum Orbit erc20Inbox without originGasToken', () => {
      const parsed = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'arbitrumOrbit',
          originChain: 'ethereum',
          mode: 'erc20Inbox',
          inboxAddress: INBOX_ADDR,
        },
      });
      expect(parsed.success).to.equal(false);
    });

    it('rejects self-referencing originChain in KeyFunderConfigSchema', () => {
      const parsed = KeyFunderConfigSchema.safeParse({
        version: '1',
        roles: { relayer: { address: RELAYER_ADDR } },
        chains: {
          optimism: {
            balances: { relayer: '1' },
            bridge: {
              stack: 'opStack',
              originChain: 'optimism',
              mode: 'optimismPortal',
              bridgeContract: PORTAL_ADDR,
            },
          },
        },
      });
      expect(parsed.success).to.equal(false);
    });

    it('rejects destinationDomain above uint32 maximum and accepts 0xffffffff', () => {
      const invalid = HyperlaneHookBridgeDeliverySchema.safeParse({
        mailboxAddress: MAILBOX_ADDR,
        hookAddress: HOOK_ADDR,
        recipientAddress: FORWARDER_ADDR,
        destinationDomain: 0x1_0000_0000,
      });
      expect(invalid.success).to.equal(false);

      const valid = HyperlaneHookBridgeDeliverySchema.safeParse({
        mailboxAddress: MAILBOX_ADDR,
        hookAddress: HOOK_ADDR,
        recipientAddress: FORWARDER_ADDR,
        destinationDomain: 0xffffffff,
      });
      expect(valid.success).to.equal(true);
    });

    it('handles trailing zeros, 0/1 decimals, malformed strings, zero maxBridgeAmount, and non-erc20Inbox originGasToken cleanly via safeParse', () => {
      const zeroDecDefault = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'arbitrumOrbit',
          originChain: 'ethereum',
          mode: 'erc20Inbox',
          inboxAddress: INBOX_ADDR,
          originGasToken: { address: GAS_TOKEN_ADDR, decimals: 0 },
        },
      });
      expect(zeroDecDefault.success).to.equal(false);
      expect(
        zeroDecDefault.error?.issues.map((i) => i.path.join('.')),
      ).to.include('bridge.minBridgeThreshold');

      // "1.0" is accepted for 0 decimals, whereas "1.1" is rejected
      const zeroDecTrailingZero = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'arbitrumOrbit',
          originChain: 'ethereum',
          mode: 'erc20Inbox',
          inboxAddress: INBOX_ADDR,
          originGasToken: { address: GAS_TOKEN_ADDR, decimals: 0 },
          minBridgeThreshold: '1.0',
          maxBridgeAmount: '5.00',
        },
      });
      expect(zeroDecTrailingZero.success).to.equal(true);

      const zeroDecNonZeroFrac = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'arbitrumOrbit',
          originChain: 'ethereum',
          mode: 'erc20Inbox',
          inboxAddress: INBOX_ADDR,
          originGasToken: { address: GAS_TOKEN_ADDR, decimals: 0 },
          minBridgeThreshold: '1.1',
          maxBridgeAmount: '5',
        },
      });
      expect(zeroDecNonZeroFrac.success).to.equal(false);

      // Malformed string "abc" returns Zod regex issue without throwing in parseUnits
      const malformed = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'opStack',
          originChain: 'ethereum',
          mode: 'optimismPortal',
          bridgeContract: PORTAL_ADDR,
          minBridgeThreshold: 'abc',
        },
      });
      expect(malformed.success).to.equal(false);
      expect(malformed.error?.issues.map((i) => i.path.join('.'))).to.include(
        'bridge.minBridgeThreshold',
      );

      // Zero maxBridgeAmount is rejected
      const zeroCap = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'opStack',
          originChain: 'ethereum',
          mode: 'optimismPortal',
          bridgeContract: PORTAL_ADDR,
          minBridgeThreshold: '0',
          maxBridgeAmount: '0',
        },
      });
      expect(zeroCap.success).to.equal(false);

      // Unused originGasToken with decimals: 0 in retryableTicket mode does not reject 0.01 threshold
      const retryableWithUnusedToken = ChainConfigSchema.safeParse({
        bridge: {
          stack: 'arbitrumOrbit',
          originChain: 'ethereum',
          mode: 'retryableTicket',
          inboxAddress: INBOX_ADDR,
          originGasToken: { address: GAS_TOKEN_ADDR, decimals: 0 },
        },
      });
      expect(retryableWithUnusedToken.success).to.equal(true);
    });
  });

  it('rejects bridge thresholds that exceed native destination metadata decimals before funding', async () => {
    const { multiProvider, sendTransaction } = createMockSetup({
      destNativeDecimals: 6,
    });
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        mode: {
          balances: { relayer: '1' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'optimismPortal',
            bridgeContract: PORTAL_ADDR,
            minBridgeThreshold: '0.0000001',
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });

    await expect(keyFunder.fundChain('mode')).to.be.rejectedWith(
      'exceeds token precision of 6 decimals',
    );
    sinon.assert.notCalled(sendTransaction);
  });

  it('bridges ETH to an OP Stack rollup via OptimismPortal.depositTransaction', async () => {
    const { multiProvider, sendTransaction } = createMockSetup();
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        mode: {
          balances: { relayer: '0.5' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'optimismPortal',
            bridgeContract: PORTAL_ADDR,
            l2GasLimit: 200_000,
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });
    await keyFunder.fundChain('mode');

    sinon.assert.calledOnce(sendTransaction);
    expect(sendTransaction.firstCall.args[0]).to.equal('ethereum');
    const tx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    expect(tx.to).to.equal(PORTAL_ADDR);
    expect(tx.value?.toString()).to.equal(
      ethers.utils.parseEther('0.5').toString(),
    );
    const decoded = BRIDGE_INTERFACES.optimismPortal.decodeFunctionData(
      'depositTransaction',
      tx.data ?? '0x',
    );
    expect(decoded._to.toLowerCase()).to.equal(RELAYER_ADDR);
    expect(decoded._isCreation).to.equal(false);
    expect(decoded._gasLimit.toNumber()).to.equal(200_000);
  });

  it('bridges ETH to an OP Stack rollup via L1StandardBridge.depositETHTo', async () => {
    const { multiProvider, sendTransaction } = createMockSetup();
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        zora: {
          balances: { relayer: '0.4' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'l1StandardBridge',
            bridgeContract: L1_BRIDGE_ADDR,
            l2GasLimit: 210_000,
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });
    await keyFunder.fundChain('zora');

    sinon.assert.calledOnce(sendTransaction);
    const tx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    expect(tx.to).to.equal(L1_BRIDGE_ADDR);
    const decoded = BRIDGE_INTERFACES.l1StandardBridge.decodeFunctionData(
      'depositETHTo',
      tx.data ?? '0x',
    );
    expect(decoded._to.toLowerCase()).to.equal(RELAYER_ADDR);
    expect(decoded._minGasLimit).to.equal(210_000);
  });

  it('rejects OP Stack canonical deposit when bridgeContract has no deployed code on origin', async () => {
    const { multiProvider, sendTransaction } = createMockSetup({
      originCode: '0x',
    });
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        mode: {
          balances: { relayer: '0.5' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'optimismPortal',
            bridgeContract: PORTAL_ADDR,
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });

    await expect(keyFunder.fundChain('mode')).to.be.rejectedWith(
      `Configured OP Stack bridge contract ${PORTAL_ADDR} has no deployed contract code on ethereum`,
    );
    sinon.assert.notCalled(sendTransaction);
  });

  it('quotes 5-arg Mailbox.quoteDispatch with from set to origin signer and dispatches to a verified payable IMessageRecipient forwarder', async () => {
    const { multiProvider, sendTransaction, originProvider } = createMockSetup({
      destDomainId: 8453,
    });
    const amount = ethers.utils.parseEther('0.25');
    const protocolFee = ethers.utils.parseEther('0.001');
    const totalQuotedFee = amount.add(protocolFee);

    let capturedQuoteCallData = '';
    let capturedQuoteFrom: string | undefined;
    originProvider.call.callsFake(async (txReq) => {
      capturedQuoteFrom = await txReq.from;
      capturedQuoteCallData = await extractTxCallData(txReq);
      return BRIDGE_INTERFACES.hyperlaneMailbox.encodeFunctionResult(
        'quoteDispatch',
        [totalQuotedFee],
      );
    });

    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        base: {
          balances: { relayer: '0.25' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'hyperlaneHook',
            hookDelivery: {
              mailboxAddress: MAILBOX_ADDR,
              hookAddress: HOOK_ADDR,
              recipientAddress: FORWARDER_ADDR,
              destinationDomain: 8453,
              gasLimit: 300_000,
            },
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });
    await keyFunder.fundChain('base');

    expect(capturedQuoteFrom?.toLowerCase()).to.equal(FUNDER_ADDR);
    const expectedRecipientBytes32 = ethers.utils.hexZeroPad(
      FORWARDER_ADDR,
      32,
    );
    const expectedMessageBody = ethers.utils.hexZeroPad(RELAYER_ADDR, 32);
    const expectedMetadata = formatStandardHookMetadata({
      msgValue: amount,
      gasLimit: 300_000,
      refundAddress: FUNDER_ADDR,
    });

    const decodedQuote = BRIDGE_INTERFACES.hyperlaneMailbox.decodeFunctionData(
      'quoteDispatch',
      capturedQuoteCallData,
    );
    expect(decodedQuote.destinationDomain).to.equal(8453);
    expect(decodedQuote.recipientAddress).to.equal(expectedRecipientBytes32);
    expect(decodedQuote.messageBody).to.equal(expectedMessageBody);

    sinon.assert.calledOnce(sendTransaction);
    const tx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    expect(tx.to).to.equal(MAILBOX_ADDR);
    expect(tx.value?.toString()).to.equal(totalQuotedFee.toString());
    const decodedDispatch =
      BRIDGE_INTERFACES.hyperlaneMailbox.decodeFunctionData(
        'dispatch',
        tx.data ?? '0x',
      );
    expect(decodedDispatch.destinationDomain).to.equal(8453);
    expect(decodedDispatch.recipientAddress).to.equal(expectedRecipientBytes32);
    expect(decodedDispatch.messageBody).to.equal(expectedMessageBody);
    expect(decodedDispatch.customHook.toLowerCase()).to.equal(HOOK_ADDR);
    expect(decodedDispatch.customHookMetadata).to.equal(expectedMetadata);
  });

  it('rejects hyperlaneHook before quoting when destinationDomain does not match destination chain metadata', async () => {
    const { multiProvider, sendTransaction, originProvider } = createMockSetup({
      destDomainId: 8453,
    });

    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        base: {
          balances: { relayer: '0.25' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'hyperlaneHook',
            hookDelivery: {
              mailboxAddress: MAILBOX_ADDR,
              hookAddress: HOOK_ADDR,
              recipientAddress: FORWARDER_ADDR,
              destinationDomain: 10,
            },
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });

    await expect(keyFunder.fundChain('base')).to.be.rejectedWith(
      'Configured hookDelivery.destinationDomain (10) does not match base domain metadata (8453)',
    );
    expect(originProvider.call.called).to.equal(false);
    sinon.assert.notCalled(sendTransaction);
  });

  it('propagates Mailbox.quoteDispatch RPC failures instead of submitting with fallback value', async () => {
    const { multiProvider, sendTransaction, originProvider } =
      createMockSetup();
    originProvider.call.rejects(new Error('Mailbox quoteDispatch reverted'));

    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        base: {
          balances: { relayer: '0.25' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'hyperlaneHook',
            hookDelivery: {
              mailboxAddress: MAILBOX_ADDR,
              hookAddress: HOOK_ADDR,
              recipientAddress: FORWARDER_ADDR,
              destinationDomain: 8453,
            },
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });

    await expect(keyFunder.fundChain('base')).to.be.rejectedWith(
      'Mailbox quoteDispatch reverted',
    );
    sinon.assert.notCalled(sendTransaction);
  });

  it('rejects hyperlaneHook dispatch when destination recipientAddress is an EOA without code', async () => {
    const { multiProvider, sendTransaction } = createMockSetup({
      destCode: '0x',
    });
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        base: {
          balances: { relayer: '0.25' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'hyperlaneHook',
            hookDelivery: {
              mailboxAddress: MAILBOX_ADDR,
              hookAddress: HOOK_ADDR,
              recipientAddress: RELAYER_ADDR,
              destinationDomain: 8453,
            },
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });

    await expect(keyFunder.fundChain('base')).to.be.rejectedWith(
      `Configured Hyperlane hook recipient contract ${RELAYER_ADDR} has no deployed contract code on base`,
    );
    sinon.assert.notCalled(sendTransaction);
  });

  it('bridges ETH to an Arbitrum Orbit chain via createRetryableTicket', async () => {
    const { multiProvider, sendTransaction } = createMockSetup();
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        xai: {
          balances: { relayer: '1' },
          bridge: {
            stack: 'arbitrumOrbit',
            originChain: 'ethereum',
            mode: 'retryableTicket',
            inboxAddress: INBOX_ADDR,
            l2GasLimit: 300_000,
            maxSubmissionCostWei: '100000000000000',
            maxFeePerGasWei: '1000000000',
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });
    await keyFunder.fundChain('xai');

    sinon.assert.calledOnce(sendTransaction);
    const tx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    expect(tx.to).to.equal(INBOX_ADDR);
    const expectedValue = ethers.utils
      .parseEther('1')
      .add('100000000000000')
      .add(BigNumber.from(300_000).mul('1000000000'));
    expect(tx.value?.toString()).to.equal(expectedValue.toString());
    const decoded = BRIDGE_INTERFACES.arbitrumInbox.decodeFunctionData(
      'createRetryableTicket',
      tx.data ?? '0x',
    );
    expect(decoded.to.toLowerCase()).to.equal(RELAYER_ADDR);
  });

  it('verifies ERC20Inbox bridge token/decimals, converts 18-decimal deficit to 6-decimal origin units, and uses createRetryableTicket', async () => {
    const tokenInterface = ERC20__factory.createInterface();
    const destProvider = sinon.createStubInstance(
      ethers.providers.JsonRpcProvider,
    );
    destProvider.getBalance.resolves(BigNumber.from(0));
    destProvider.getCode.resolves(MOCK_CONTRACT_CODE);

    const originProvider = new ethers.providers.JsonRpcProvider();
    sinon.stub(originProvider, 'getCode').resolves(MOCK_CONTRACT_CODE);
    sinon
      .stub(originProvider, 'getGasPrice')
      .resolves(BigNumber.from(1_000_000_000));
    stubErc20InboxOriginCalls({
      originProvider,
      bridgeDecimals: 6,
      tokenBalance: ethers.utils.parseUnits('50', 6),
      allowance: BigNumber.from(0),
    });

    const destSigner = sinon.createStubInstance(ethers.Wallet);
    destSigner.getAddress.resolves(FUNDER_ADDR);
    destSigner.getBalance.resolves(BigNumber.from(0));

    const originSigner = sinon.createStubInstance(ethers.Wallet);
    originSigner.getAddress.resolves(FUNDER_ADDR);
    originSigner.getBalance.resolves(ethers.utils.parseEther('5'));
    originSigner.getTransactionCount.resolves(3);
    originSigner.populateTransaction.callsFake(async (tx) =>
      buildPopulatedTx(
        tx,
        BigNumber.from(120_000),
        BigNumber.from(1_000_000_000),
        3,
      ),
    );

    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getProvider.callsFake((chain) =>
      chain === 'ethereum' ? originProvider : destProvider,
    );
    multiProvider.getSigner.callsFake((chain) =>
      chain === 'ethereum' ? originSigner : destSigner,
    );
    multiProvider.getSignerAddress.resolves(FUNDER_ADDR);
    multiProvider.getChainMetadata.returns({
      chainId: 660279,
      domainId: 660279,
      nativeToken: { name: 'OrbitGas', symbol: 'OGAS', decimals: 18 },
    });
    multiProvider.prepareTx.callsFake(async (_chain, tx) => tx);
    const sendTransaction = sinon.stub<
      Parameters<MultiProvider['sendTransaction']>,
      ReturnType<MultiProvider['sendTransaction']>
    >();
    sendTransaction.resolves(
      buildContractReceipt({ transactionHash: `0x${'cd'.repeat(32)}` }),
    );
    multiProvider.sendTransaction = sendTransaction;

    const metrics = sinon.createStubInstance(KeyFunderMetrics);

    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        orbitcustom: {
          balances: { relayer: '2' },
          bridge: {
            stack: 'arbitrumOrbit',
            originChain: 'ethereum',
            mode: 'erc20Inbox',
            inboxAddress: INBOX_ADDR,
            originGasToken: { address: GAS_TOKEN_ADDR, decimals: 6 },
            l2GasLimit: 300_000,
            maxSubmissionCostWei: '100000000000000',
            maxFeePerGasWei: '1000000000',
            maxBridgeAmount: '5',
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
      metrics,
    });
    await keyFunder.fundChain('orbitcustom');

    sinon.assert.calledTwice(sendTransaction);
    const approveTx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    const expectedTokenTotalFee = BigNumber.from(2_000_400);
    const decodedApprove = tokenInterface.decodeFunctionData(
      'approve',
      approveTx.data ?? '0x',
    );
    expect(decodedApprove[1].toString()).to.equal(
      expectedTokenTotalFee.toString(),
    );

    const depositTx = await Promise.resolve(sendTransaction.secondCall.args[1]);
    const decodedRetryable =
      BRIDGE_INTERFACES.arbitrumErc20Inbox.decodeFunctionData(
        'createRetryableTicket',
        depositTx.data ?? '0x',
      );
    expect(decodedRetryable.to.toLowerCase()).to.equal(RELAYER_ADDR);
    expect(decodedRetryable.l2CallValue.toString()).to.equal(
      ethers.utils.parseEther('2').toString(),
    );
    expect(decodedRetryable.tokenTotalFeeAmount.toString()).to.equal(
      expectedTokenTotalFee.toString(),
    );

    expect(
      metrics.recordFundingAmount.calledOnceWithExactly(
        'orbitcustom',
        RELAYER_ADDR,
        'relayer',
        2,
      ),
    ).to.equal(true);
  });

  it('rejects Arbitrum Orbit erc20Inbox before approving when configured decimals mismatch the Inbox bridge', async () => {
    const destProvider = sinon.createStubInstance(
      ethers.providers.JsonRpcProvider,
    );
    destProvider.getBalance.resolves(BigNumber.from(0));
    destProvider.getCode.resolves(MOCK_CONTRACT_CODE);

    const originProvider = new ethers.providers.JsonRpcProvider();
    sinon.stub(originProvider, 'getCode').resolves(MOCK_CONTRACT_CODE);
    stubErc20InboxOriginCalls({
      originProvider,
      bridgeDecimals: 6,
      tokenDecimals: 6,
      tokenBalance: ethers.utils.parseEther('50'),
      allowance: BigNumber.from(0),
    });

    const destSigner = sinon.createStubInstance(ethers.Wallet);
    destSigner.getAddress.resolves(FUNDER_ADDR);
    destSigner.getBalance.resolves(BigNumber.from(0));

    const originSigner = sinon.createStubInstance(ethers.Wallet);
    originSigner.getAddress.resolves(FUNDER_ADDR);
    originSigner.getBalance.resolves(ethers.utils.parseEther('5'));

    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getProvider.callsFake((chain) =>
      chain === 'ethereum' ? originProvider : destProvider,
    );
    multiProvider.getSigner.callsFake((chain) =>
      chain === 'ethereum' ? originSigner : destSigner,
    );
    multiProvider.getSignerAddress.resolves(FUNDER_ADDR);
    multiProvider.getChainMetadata.returns({
      nativeToken: { name: 'OrbitGas', symbol: 'OGAS', decimals: 18 },
    });
    const sendTransaction = sinon.stub<
      Parameters<MultiProvider['sendTransaction']>,
      ReturnType<MultiProvider['sendTransaction']>
    >();
    multiProvider.sendTransaction = sendTransaction;

    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        orbitcustom: {
          balances: { relayer: '2' },
          bridge: {
            stack: 'arbitrumOrbit',
            originChain: 'ethereum',
            mode: 'erc20Inbox',
            inboxAddress: INBOX_ADDR,
            originGasToken: { address: GAS_TOKEN_ADDR, decimals: 18 },
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });

    await expect(keyFunder.fundChain('orbitcustom')).to.be.rejectedWith(
      'Arbitrum Orbit ERC20 gas token decimals mismatch on ethereum: configured 18, bridge reports 6, token reports 6',
    );
    sinon.assert.notCalled(sendTransaction);
  });

  it('resets insufficient nonzero ERC20 allowance to zero before approving new amount and uses depositERC20 for self-recipient', async () => {
    const tokenInterface = ERC20__factory.createInterface();
    const destProvider = sinon.createStubInstance(
      ethers.providers.JsonRpcProvider,
    );
    destProvider.getBalance.resolves(BigNumber.from(0));
    destProvider.getCode.resolves(MOCK_CONTRACT_CODE);

    const originProvider = new ethers.providers.JsonRpcProvider();
    sinon.stub(originProvider, 'getCode').resolves(MOCK_CONTRACT_CODE);
    sinon
      .stub(originProvider, 'getGasPrice')
      .resolves(BigNumber.from(1_000_000_000));
    stubErc20InboxOriginCalls({
      originProvider,
      bridgeDecimals: 18,
      tokenBalance: ethers.utils.parseEther('50'),
      allowance: ethers.utils.parseEther('0.5'),
    });

    const destSigner = sinon.createStubInstance(ethers.Wallet);
    destSigner.getAddress.resolves(FUNDER_ADDR);
    destSigner.getBalance.resolves(BigNumber.from(0));

    const originSigner = sinon.createStubInstance(ethers.Wallet);
    originSigner.getAddress.resolves(FUNDER_ADDR);
    originSigner.getBalance.resolves(ethers.utils.parseEther('5'));
    originSigner.getTransactionCount.resolves(4);
    originSigner.populateTransaction.callsFake(async (tx) =>
      buildPopulatedTx(
        tx,
        BigNumber.from(60_000),
        BigNumber.from(1_000_000_000),
        4,
      ),
    );

    const multiProvider = sinon.createStubInstance(MultiProvider);
    multiProvider.getProvider.callsFake((chain) =>
      chain === 'ethereum' ? originProvider : destProvider,
    );
    multiProvider.getSigner.callsFake((chain) =>
      chain === 'ethereum' ? originSigner : destSigner,
    );
    multiProvider.getSignerAddress.resolves(FUNDER_ADDR);
    multiProvider.getChainMetadata.returns({
      nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    });
    multiProvider.prepareTx.callsFake(async (_chain, tx) => tx);

    let txSeq = 0;
    const sendTransaction = sinon.stub<
      Parameters<MultiProvider['sendTransaction']>,
      ReturnType<MultiProvider['sendTransaction']>
    >();
    sendTransaction.callsFake(async () => {
      txSeq += 1;
      return buildContractReceipt({
        transactionHash: `0x${String(txSeq).padStart(64, '0')}`,
      });
    });
    multiProvider.sendTransaction = sendTransaction;

    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { selfRole: { address: FUNDER_ADDR } },
      chains: {
        orbitself: {
          balances: { selfRole: '2' },
          bridge: {
            stack: 'arbitrumOrbit',
            originChain: 'ethereum',
            mode: 'erc20Inbox',
            inboxAddress: INBOX_ADDR,
            originGasToken: { address: GAS_TOKEN_ADDR, decimals: 18 },
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });
    await keyFunder.fundChain('orbitself');

    sinon.assert.calledThrice(sendTransaction);

    const resetTx = await Promise.resolve(sendTransaction.firstCall.args[1]);
    const decodedReset = tokenInterface.decodeFunctionData(
      'approve',
      resetTx.data ?? '0x',
    );
    expect(decodedReset[1].toString()).to.equal('0');

    const approveTx = await Promise.resolve(sendTransaction.secondCall.args[1]);
    const decodedApprove = tokenInterface.decodeFunctionData(
      'approve',
      approveTx.data ?? '0x',
    );
    expect(decodedApprove[1].toString()).to.equal(
      ethers.utils.parseEther('2').toString(),
    );

    const depositTx = await Promise.resolve(sendTransaction.thirdCall.args[1]);
    const decodedDeposit =
      BRIDGE_INTERFACES.arbitrumErc20Inbox.decodeFunctionData(
        'depositERC20',
        depositTx.data ?? '0x',
      );
    expect(decodedDeposit._amount.toString()).to.equal(
      ethers.utils.parseEther('2').toString(),
    );
  });

  it('includes prepared origin gas fees and unresolved unmined origin spends in originReserveBuffer enforcement', async () => {
    // Part 1: 1 ETH deposit + 0.05 ETH reserve + 0.0002 ETH gas = 1.0502 ETH > 1.0501 ETH balance
    const { multiProvider, sendTransaction } = createMockSetup({
      originFunderBalance: ethers.utils.parseEther('1.0501'),
      originGasLimit: BigNumber.from(200_000),
      originMaxFeePerGas: BigNumber.from(1_000_000_000),
    });
    const singleConfig: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        mode: {
          balances: { relayer: '2' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'optimismPortal',
            bridgeContract: PORTAL_ADDR,
            maxBridgeAmount: '1',
            originReserveBuffer: '0.05',
          },
        },
      },
    });

    const singleFunder = new KeyFunder(multiProvider, singleConfig, {
      logger: pino({ level: 'silent' }),
    });
    await expect(singleFunder.fundChain('mode')).to.be.rejectedWith(
      'Insufficient origin balance on ethereum',
    );
    sinon.assert.notCalled(sendTransaction);

    // Part 2: First destination confirmation times out while tx is still unmined in mempool (origin balance still 1.5 ETH).
    // Second destination must account for the unresolved 0.7001 ETH spend and reject so reserve (0.5 ETH) stays protected.
    const concurrent = createMockSetup({
      originFunderBalance: ethers.utils.parseEther('1.5'),
      originGasLimit: BigNumber.from(100_000),
      originMaxFeePerGas: BigNumber.from(1_000_000_000),
    });
    const unminedHash = `0x${'44'.repeat(32)}`;
    concurrent.sendTransaction.onFirstCall().callsFake(async (_c, _t, opts) => {
      await opts?.onSubmissionAttempt?.(unminedHash);
      await opts?.onSubmitted?.(unminedHash);
      throw new TransactionSubmissionError(
        new Error('Confirmation timed out'),
        'submitted',
        unminedHash,
      );
    });

    const multiChainCfg: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: { relayer: { address: RELAYER_ADDR } },
      chains: {
        mode: {
          balances: { relayer: '0.7001' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'optimismPortal',
            bridgeContract: PORTAL_ADDR,
            originReserveBuffer: '0.5',
          },
        },
        zora: {
          balances: { relayer: '0.7001' },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'l1StandardBridge',
            bridgeContract: L1_BRIDGE_ADDR,
            originReserveBuffer: '0.5',
          },
        },
      },
    });

    const multiFunder = new KeyFunder(concurrent.multiProvider, multiChainCfg, {
      logger: pino({ level: 'silent' }),
    });
    await expect(multiFunder.fundAllChains()).to.be.rejectedWith(
      '2/2 chains failed to fund',
    );
    sinon.assert.calledOnce(concurrent.sendTransaction);
  });

  it('prevents duplicate bridging when multiple roles share the same recipient address while funds are in transit', async () => {
    const { multiProvider, sendTransaction } = createMockSetup();
    const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
      version: '1',
      roles: {
        relayer: { address: RELAYER_ADDR },
        validator: { address: RELAYER_ADDR },
      },
      chains: {
        mode: {
          balances: {
            relayer: '0.5',
            validator: '0.5',
          },
          bridge: {
            stack: 'opStack',
            originChain: 'ethereum',
            mode: 'optimismPortal',
            bridgeContract: PORTAL_ADDR,
          },
        },
      },
    });

    const keyFunder = new KeyFunder(multiProvider, config, {
      logger: pino({ level: 'silent' }),
    });
    await keyFunder.fundChain('mode');

    sinon.assert.calledOnce(sendTransaction);
  });

  it('persists prepared attempt on disk before onSubmitted, ignores unrelated balance increases, and clears delivered deposit even after funds are spent', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'keyfunder-bridge-state-'),
    );
    const stateFile = path.join(tmpDir, 'bridge-state.json');

    try {
      const broadcastHash = `0x${'77'.repeat(32)}`;
      const { log: opDepositLog, l2TxHash } = buildOpStackDepositLog({
        value: ethers.utils.parseEther('0.5'),
      });
      const storeInspector = new FileBridgeStateStore(stateFile);

      const setup1 = createMockSetup({ originNonce: 8 });
      let snapshotAfterAttemptPhase = '';
      let snapshotAfterAttemptStage = '';
      let snapshotAfterAttemptHash = '';
      let snapshotAfterAttemptNonce = -1;

      setup1.sendTransaction.callsFake(
        async (_chain, _tx, options?: SendTransactionOptions) => {
          await options?.onSubmissionAttempt?.(broadcastHash);
          // Read directly from disk BEFORE onSubmitted is called!
          const midAttempt = await storeInspector.get('mode', RELAYER_ADDR);
          snapshotAfterAttemptPhase = midAttempt?.phase ?? '';
          snapshotAfterAttemptStage = midAttempt?.broadcastStage ?? '';
          snapshotAfterAttemptHash = midAttempt?.depositTxHash ?? '';
          snapshotAfterAttemptNonce = midAttempt?.originNonce ?? -1;

          await options?.onSubmitted?.(broadcastHash);
          throw new TransactionSubmissionError(
            new Error('Timeout waiting for block confirmations'),
            'submitted',
            broadcastHash,
          );
        },
      );

      const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
        version: '1',
        roles: { relayer: { address: RELAYER_ADDR } },
        chains: {
          mode: {
            balances: { relayer: '2' },
            bridge: {
              stack: 'opStack',
              originChain: 'ethereum',
              mode: 'optimismPortal',
              bridgeContract: PORTAL_ADDR,
              maxBridgeAmount: '0.5',
            },
          },
        },
      });

      const keyFunder1 = new KeyFunder(setup1.multiProvider, config, {
        logger: pino({ level: 'silent' }),
        bridgeStateFile: stateFile,
      });

      await expect(keyFunder1.fundChain('mode')).to.be.rejectedWith(
        'Timeout waiting for block confirmations',
      );

      // Verify state was persisted BEFORE broadcast acknowledgment (inside onSubmissionAttempt)
      expect(snapshotAfterAttemptPhase).to.equal('prepared');
      expect(snapshotAfterAttemptStage).to.equal('attempting');
      expect(snapshotAfterAttemptHash).to.equal(broadcastHash);
      expect(snapshotAfterAttemptNonce).to.equal(8);

      const persisted = await storeInspector.get('mode', RELAYER_ADDR);
      expect(persisted?.phase).to.equal('submitted');
      expect(persisted?.depositTxHash).to.equal(broadcastHash);

      // Restart 1: Origin receipt is mined with TransactionDeposited log, recipient got an unrelated 0.45 ETH top-up,
      // but L2 deposit receipt is NOT yet mined => must NOT clear attempt and must NOT submit a second bridge!
      const setup2 = createMockSetup({
        destRoleBalance: ethers.utils.parseEther('0.45'),
      });
      setup2.originProvider.getTransactionReceipt.resolves(
        buildContractReceipt({
          transactionHash: broadcastHash,
          logs: [opDepositLog],
        }),
      );

      const keyFunder2 = new KeyFunder(setup2.multiProvider, config, {
        logger: pino({ level: 'silent' }),
        bridgeStateFile: stateFile,
      });
      await keyFunder2.fundChain('mode');

      sinon.assert.notCalled(setup2.sendTransaction);
      const stillInTransit = await storeInspector.get('mode', RELAYER_ADDR);
      expect(stillInTransit?.phase).to.equal('confirmed');
      expect(stillInTransit?.deliveryRef).to.deep.equal({
        kind: BridgeDeliveryKind.OpStackDeposit,
        l2TxHash,
      });

      // Restart 2: L2 deposit receipt IS now mined (status = 1), AND the relayer already spent its balance down to 0.1 ETH!
      // Reconciliation must clear the delivered deposit and fund a fresh capped 0.5 ETH bridge!
      const setup3 = createMockSetup({
        destRoleBalance: ethers.utils.parseEther('0.1'),
      });
      setup3.destProvider.getTransactionReceipt
        .withArgs(l2TxHash)
        .resolves(buildContractReceipt({ transactionHash: l2TxHash }));

      const keyFunder3 = new KeyFunder(setup3.multiProvider, config, {
        logger: pino({ level: 'silent' }),
        bridgeStateFile: stateFile,
      });
      await keyFunder3.fundChain('mode');

      sinon.assert.calledOnce(setup3.sendTransaction);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('recovers submitted deposits replaced by a finalized cancellation and clears expired Arbitrum retryables', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'keyfunder-bridge-recovery-'),
    );
    const stateFile = path.join(tmpDir, 'bridge-state.json');

    try {
      const canceledHash = `0x${'99'.repeat(32)}`;
      const store = new FileBridgeStateStore(stateFile);
      await store.set({
        originChain: 'ethereum',
        destinationChain: 'mode',
        recipient: RELAYER_ADDR,
        funderAddress: FUNDER_ADDR,
        stack: BridgeStack.OpStack,
        mode: OpStackBridgeMode.OptimismPortal,
        bridgedAmount: ethers.utils.parseEther('0.5').toString(),
        baselineDestinationBalance: '0',
        originNativeValue: ethers.utils.parseEther('0.5').toString(),
        originGasBudget: '100000000000000',
        originNonce: 8,
        broadcastStage: 'submitted',
        depositTxHash: canceledHash,
        approvalTxHashes: [],
        phase: 'submitted',
        createdAtMs: Date.now() - 20_000,
        updatedAtMs: Date.now() - 20_000,
      });

      // Origin finalized height (block 200 - 32 = 168) has nonce 9 > 8, and canceledHash has no receipt!
      const setup1 = createMockSetup({ originNonce: 9 });
      setup1.originProvider.getBlockNumber.resolves(200);
      setup1.originProvider.getTransactionCount.resolves(9);

      const opConfig: KeyFunderConfig = KeyFunderConfigSchema.parse({
        version: '1',
        roles: { relayer: { address: RELAYER_ADDR } },
        chains: {
          mode: {
            balances: { relayer: '0.5' },
            bridge: {
              stack: 'opStack',
              originChain: 'ethereum',
              mode: 'optimismPortal',
              bridgeContract: PORTAL_ADDR,
            },
          },
        },
      });

      const keyFunder1 = new KeyFunder(setup1.multiProvider, opConfig, {
        logger: pino({ level: 'silent' }),
        bridgeStateFile: stateFile,
      });
      await keyFunder1.fundChain('mode');
      sinon.assert.calledOnce(setup1.sendTransaction);

      // Now test expired Arbitrum retryable ticket recovery
      const retryableLogs = buildArbitrumRetryableLogs({});
      const arbOriginHash = `0x${'88'.repeat(32)}`;
      await store.set({
        originChain: 'ethereum',
        destinationChain: 'xai',
        recipient: RELAYER_ADDR,
        funderAddress: FUNDER_ADDR,
        stack: BridgeStack.ArbitrumOrbit,
        mode: ArbitrumOrbitBridgeMode.RetryableTicket,
        bridgedAmount: ethers.utils.parseEther('1').toString(),
        baselineDestinationBalance: '0',
        originNativeValue: ethers.utils.parseEther('1').toString(),
        originGasBudget: '100000000000000',
        originNonce: 10,
        broadcastStage: 'submitted',
        depositTxHash: arbOriginHash,
        approvalTxHashes: [],
        phase: 'submitted',
        createdAtMs: Date.now() - 30_000,
        updatedAtMs: Date.now() - 30_000,
      });

      const setup2 = createMockSetup({ destDomainId: 660279 });
      setup2.originProvider.getTransactionReceipt.resolves(
        buildContractReceipt({
          transactionHash: arbOriginHash,
          logs: retryableLogs,
        }),
      );
      // Creation tx succeeded on L2, auto-redeem absent, and getTimeout(ticketId) is in the past (expired)
      setup2.destProvider.getTransactionReceipt.resolves(
        buildContractReceipt({ status: 1, logs: [] }),
      );
      setup2.destProvider.call.callsFake(async (tx) => {
        const to = (await tx.to)?.toLowerCase();
        if (to === ARB_RETRYABLE_TX_ADDRESS.toLowerCase()) {
          return DELIVERY_EVENT_INTERFACES.arbitrumRetryablePrecompile.encodeFunctionResult(
            'getTimeout',
            [BigNumber.from(1_000)],
          );
        }
        throw new Error('Unexpected dest call');
      });
      setup2.destProvider.getBlock.resolves(buildBlock({ timestamp: 2_000 }));

      const arbConfig: KeyFunderConfig = KeyFunderConfigSchema.parse({
        version: '1',
        roles: { relayer: { address: RELAYER_ADDR } },
        chains: {
          xai: {
            balances: { relayer: '1' },
            bridge: {
              stack: 'arbitrumOrbit',
              originChain: 'ethereum',
              mode: 'retryableTicket',
              inboxAddress: INBOX_ADDR,
            },
          },
        },
      });

      const keyFunder2 = new KeyFunder(setup2.multiProvider, arbConfig, {
        logger: pino({ level: 'silent' }),
        bridgeStateFile: stateFile,
      });
      await keyFunder2.fundChain('xai');
      sinon.assert.calledOnce(setup2.sendTransaction);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('survives origin reconciliation RPC errors, funds uncovered deficit locally, and continues funding other keys', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'keyfunder-bridge-rpcerr-'),
    );
    const stateFile = path.join(tmpDir, 'bridge-state.json');

    try {
      const store = new FileBridgeStateStore(stateFile);
      await store.set({
        originChain: 'ethereum',
        destinationChain: 'mode',
        recipient: RELAYER_ADDR,
        funderAddress: FUNDER_ADDR,
        stack: BridgeStack.OpStack,
        mode: OpStackBridgeMode.OptimismPortal,
        bridgedAmount: ethers.utils.parseEther('0.5').toString(),
        baselineDestinationBalance: '0',
        originNativeValue: ethers.utils.parseEther('0.5').toString(),
        originGasBudget: '100000000000000',
        originNonce: 7,
        broadcastStage: 'submitted',
        depositTxHash: `0x${'33'.repeat(32)}`,
        approvalTxHashes: [],
        phase: 'submitted',
        createdAtMs: Date.now() - 5_000,
        updatedAtMs: Date.now() - 5_000,
      });

      // Relayer has 0.05 ETH (desired 1.0 => raw deficit 0.95 ETH, pending bridge 0.5 ETH => uncovered 0.45 ETH).
      // Destination funder holds 2.0 ETH locally (e.g. after IGP claim), while origin RPC throws!
      const { multiProvider, originProvider, destProvider, sendTransaction } =
        createMockSetup({
          destFunderBalance: ethers.utils.parseEther('2'),
        });
      destProvider.getBalance.callsFake(async (addr) => {
        const resolved = await addr;
        return resolved.toLowerCase() === RELAYER_ADDR
          ? ethers.utils.parseEther('0.05')
          : BigNumber.from(0);
      });
      originProvider.getTransactionReceipt.rejects(
        new Error('Origin RPC temporarily unavailable'),
      );

      const config: KeyFunderConfig = KeyFunderConfigSchema.parse({
        version: '1',
        roles: {
          relayer: { address: RELAYER_ADDR },
          validator: { address: VALIDATOR_ADDR },
        },
        chains: {
          mode: {
            balances: {
              relayer: '1',
              validator: '0.4',
            },
            bridge: {
              stack: 'opStack',
              originChain: 'ethereum',
              mode: 'optimismPortal',
              bridgeContract: PORTAL_ADDR,
            },
          },
        },
      });

      const keyFunder = new KeyFunder(multiProvider, config, {
        logger: pino({ level: 'silent' }),
        bridgeStateFile: stateFile,
      });
      await keyFunder.fundChain('mode');

      // Both keys funded locally on 'mode': 0.45 ETH uncovered deficit for relayer + 0.4 ETH for validator!
      sinon.assert.calledTwice(sendTransaction);
      expect(sendTransaction.firstCall.args[0]).to.equal('mode');
      const relayerTx = await Promise.resolve(
        sendTransaction.firstCall.args[1],
      );
      expect(relayerTx.to?.toLowerCase()).to.equal(RELAYER_ADDR);
      expect(relayerTx.value?.toString()).to.equal(
        ethers.utils.parseEther('0.45').toString(),
      );

      expect(sendTransaction.secondCall.args[0]).to.equal('mode');
      const validatorTx = await Promise.resolve(
        sendTransaction.secondCall.args[1],
      );
      expect(validatorTx.to?.toLowerCase()).to.equal(VALIDATOR_ADDR);
      expect(validatorTx.value?.toString()).to.equal(
        ethers.utils.parseEther('0.4').toString(),
      );

      // Pending bridge attempt for relayer remains retained in store
      const retained = await store.get('mode', RELAYER_ADDR);
      expect(retained?.depositTxHash).to.equal(`0x${'33'.repeat(32)}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('validates stored state version/records at read boundary and preserves concurrent updates across store instances', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'keyfunder-store-boundary-'),
    );
    const stateFile = path.join(tmpDir, 'bridge-state.json');

    try {
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ version: 99, attempts: {} }),
      );
      const badVersionStore = new FileBridgeStateStore(stateFile);
      await expect(
        badVersionStore.get('mode', RELAYER_ADDR),
      ).to.be.rejectedWith('Unsupported bridge state file version');

      fs.writeFileSync(
        stateFile,
        JSON.stringify({ version: 1, attempts: { 'mode:0x1111': {} } }),
      );
      await expect(
        badVersionStore.get('mode', RELAYER_ADDR),
      ).to.be.rejectedWith('Invalid bridge state record "mode:0x1111"');

      fs.unlinkSync(stateFile);

      // Concurrent writes from two independent FileBridgeStateStore instances sharing the same file
      const storeA = new FileBridgeStateStore(stateFile);
      const storeB = new FileBridgeStateStore(stateFile);
      const baseAttempt = {
        originChain: 'ethereum',
        funderAddress: FUNDER_ADDR,
        stack: BridgeStack.OpStack,
        mode: OpStackBridgeMode.OptimismPortal,
        bridgedAmount: '100',
        baselineDestinationBalance: '0',
        originNativeValue: '100',
        originGasBudget: '10',
        broadcastStage: 'submitted' as const,
        approvalTxHashes: [],
        phase: 'submitted' as const,
        createdAtMs: 1,
        updatedAtMs: 1,
      };

      await Promise.all([
        storeA.set({
          ...baseAttempt,
          destinationChain: 'mode',
          recipient: RELAYER_ADDR,
        }),
        storeB.set({
          ...baseAttempt,
          destinationChain: 'zora',
          recipient: VALIDATOR_ADDR,
        }),
      ]);

      const readMode = await storeA.get('mode', RELAYER_ADDR);
      const readZora = await storeB.get('zora', VALIDATOR_ADDR);
      expect(readMode?.recipient).to.equal(RELAYER_ADDR);
      expect(readZora?.recipient).to.equal(VALIDATOR_ADDR);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
