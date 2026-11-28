import { BigNumber, ethers } from 'ethers';
import type { PopulatedTransaction } from 'ethers';
import type { Logger } from 'pino';

import { ERC20__factory } from '@hyperlane-xyz/core';
import type { MultiProvider } from '@hyperlane-xyz/sdk';
import {
  TransactionSubmissionError,
  assert,
  eqAddress,
} from '@hyperlane-xyz/utils';

import type {
  ArbitrumOrbitBridgeConfig,
  BridgeConfig,
  HyperlaneHookBridgeDelivery,
  OpStackBridgeConfig,
} from '../config/types.js';

import {
  type BridgeStateStore,
  type PersistedBridgeAttempt,
  reconcilePendingBridgeAttempt,
  withRecipientBridgeLock,
} from './BridgeStateStore.js';

const ERC20_APPROVE_GAS_ESTIMATE = BigNumber.from(65_000);
const ERC20_INBOX_DEPOSIT_GAS_ESTIMATE = BigNumber.from(300_000);

export const BRIDGE_INTERFACES = {
  optimismPortal: new ethers.utils.Interface([
    'function depositTransaction(address _to, uint256 _value, uint64 _gasLimit, bool _isCreation, bytes _data) payable',
  ]),
  l1StandardBridge: new ethers.utils.Interface([
    'function depositETHTo(address _to, uint32 _minGasLimit, bytes _extraData) payable',
  ]),
  arbitrumInbox: new ethers.utils.Interface([
    'function depositEth() payable returns (uint256)',
    'function createRetryableTicket(address to, uint256 l2CallValue, uint256 maxSubmissionCost, address excessFeeRefundAddress, address callValueRefundAddress, uint256 gasLimit, uint256 maxFeePerGas, bytes data) payable returns (uint256)',
  ]),
  arbitrumErc20Inbox: new ethers.utils.Interface([
    'function depositERC20(uint256 _amount) returns (uint256)',
    'function createRetryableTicket(address to, uint256 l2CallValue, uint256 maxSubmissionCost, address excessFeeRefundAddress, address callValueRefundAddress, uint256 gasLimit, uint256 maxFeePerGas, uint256 tokenTotalFeeAmount, bytes data) returns (uint256)',
  ]),
  hyperlaneMailbox: new ethers.utils.Interface([
    'function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes messageBody, bytes customHookMetadata, address customHook) payable returns (bytes32)',
    'function quoteDispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes messageBody, bytes customHookMetadata, address customHook) view returns (uint256)',
  ]),
  hyperlanePostDispatchHook: new ethers.utils.Interface([
    'function quoteDispatch(bytes metadata, bytes message) view returns (uint256)',
  ]),
} as const;

export function formatStandardHookMetadata(params: {
  msgValue: BigNumber;
  gasLimit: number;
  refundAddress: string;
}): string {
  return ethers.utils.solidityPack(
    ['uint16', 'uint256', 'uint256', 'address'],
    [1, params.msgValue, BigNumber.from(params.gasLimit), params.refundAddress],
  );
}

export interface BridgeFundingResult {
  /** Credited amount denominated in destination-chain base units. */
  bridgedAmount: BigNumber;
  txHashes: string[];
}

function getBridgeDecimals(
  bridge: BridgeConfig,
  destinationDecimals: number,
): number {
  if (bridge.stack === 'arbitrumOrbit' && bridge.mode === 'erc20Inbox') {
    return bridge.originGasToken?.decimals ?? destinationDecimals;
  }
  return destinationDecimals;
}

export function scaleUnitsFloor(
  value: BigNumber,
  fromDecimals: number,
  toDecimals: number,
): BigNumber {
  if (fromDecimals === toDecimals || value.isZero()) {
    return value;
  }
  if (toDecimals > fromDecimals) {
    const factor = BigNumber.from(10).pow(toDecimals - fromDecimals);
    return value.mul(factor);
  }
  const factor = BigNumber.from(10).pow(fromDecimals - toDecimals);
  return value.div(factor);
}

export function scaleUnitsCeil(
  value: BigNumber,
  fromDecimals: number,
  toDecimals: number,
): BigNumber {
  if (fromDecimals === toDecimals || value.isZero()) {
    return value;
  }
  if (toDecimals > fromDecimals) {
    const factor = BigNumber.from(10).pow(toDecimals - fromDecimals);
    return value.mul(factor);
  }
  const factor = BigNumber.from(10).pow(fromDecimals - toDecimals);
  return value.add(factor.sub(1)).div(factor);
}

const originSignerLocks = new Map<string, Promise<void>>();

/**
 * Serializes origin balance checks and spending across concurrent destination
 * bridges that share the same (originChain, signer) account.
 */
async function withOriginSignerLock<T>(
  originChain: string,
  signerAddress: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${originChain}:${signerAddress.toLowerCase()}`;
  const previous = originSignerLocks.get(key) ?? Promise.resolve();
  const execution = previous.then(operation);
  const settled = execution.then(
    () => undefined,
    () => undefined,
  );
  originSignerLocks.set(key, settled);
  try {
    return await execution;
  } finally {
    if (originSignerLocks.get(key) === settled) {
      originSignerLocks.delete(key);
    }
  }
}

async function assertDeployedContract(
  provider: ethers.providers.Provider,
  chain: string,
  address: string,
  label: string,
): Promise<void> {
  const code = await provider.getCode(address);
  if (!code || code === '0x' || code === '0x0') {
    throw new Error(
      `Configured ${label} ${address} has no deployed contract code on ${chain}`,
    );
  }
}

async function populateOriginTxWithGasCost(
  multiProvider: MultiProvider,
  originChain: string,
  tx: PopulatedTransaction,
): Promise<{
  transaction: PopulatedTransaction;
  gasCost: BigNumber;
  feePerGas: BigNumber;
}> {
  const signer = multiProvider.getSigner(originChain);
  const prepared = await multiProvider.prepareTx(originChain, tx);
  const populated =
    typeof signer.populateTransaction === 'function'
      ? await signer.populateTransaction(prepared)
      : undefined;

  const gasLimitRaw =
    populated?.gasLimit ??
    tx.gasLimit ??
    (await multiProvider.estimateGas(originChain, tx));
  const feePerGasRaw =
    populated?.maxFeePerGas ??
    populated?.gasPrice ??
    tx.maxFeePerGas ??
    tx.gasPrice ??
    (await multiProvider.getProvider(originChain).getGasPrice());

  const gasLimit = BigNumber.from(gasLimitRaw);
  const feePerGas = BigNumber.from(feePerGasRaw);
  const gasCost = gasLimit.mul(feePerGas);

  const merged: PopulatedTransaction = {
    ...tx,
    gasLimit,
    ...(populated?.type != null ? { type: populated.type } : {}),
    ...(populated?.maxFeePerGas != null
      ? {
          maxFeePerGas: BigNumber.from(populated.maxFeePerGas),
          ...(populated.maxPriorityFeePerGas != null
            ? {
                maxPriorityFeePerGas: BigNumber.from(
                  populated.maxPriorityFeePerGas,
                ),
              }
            : {}),
        }
      : populated?.gasPrice != null
        ? { gasPrice: BigNumber.from(populated.gasPrice) }
        : {}),
  };

  return { transaction: merged, gasCost, feePerGas };
}

async function assertOriginNativeReserve(params: {
  multiProvider: MultiProvider;
  originChain: string;
  requiredValue: BigNumber;
  gasCost: BigNumber;
  reserveBufferStr: string;
}): Promise<void> {
  const {
    multiProvider,
    originChain,
    requiredValue,
    gasCost,
    reserveBufferStr,
  } = params;
  const nativeDecimals =
    multiProvider.getChainMetadata(originChain).nativeToken?.decimals ?? 18;
  const signer = multiProvider.getSigner(originChain);
  const originBalance = await signer.getBalance();
  const reserveBuffer = ethers.utils.parseUnits(
    reserveBufferStr,
    nativeDecimals,
  );
  const totalRequired = requiredValue.add(gasCost).add(reserveBuffer);
  if (originBalance.lt(totalRequired)) {
    throw new Error(
      `Insufficient origin balance on ${originChain}: has ${ethers.utils.formatUnits(originBalance, nativeDecimals)}, needs ${ethers.utils.formatUnits(totalRequired, nativeDecimals)} (including gas fees and reserve buffer)`,
    );
  }
}

interface DepositPersistenceContext {
  stateStore?: BridgeStateStore;
  destinationChain: string;
  recipient: string;
  funderAddress: string;
  bridge: BridgeConfig;
  bridgedDestinationAmount: BigNumber;
  baselineDestinationBalance: BigNumber;
}

function extractAttachedTxHash(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as {
    txHash?: unknown;
    transactionHash?: unknown;
    transaction?: { hash?: unknown };
  };
  if (typeof candidate.txHash === 'string' && candidate.txHash.length > 0) {
    return candidate.txHash;
  }
  if (
    typeof candidate.transactionHash === 'string' &&
    candidate.transactionHash.length > 0
  ) {
    return candidate.transactionHash;
  }
  if (
    typeof candidate.transaction?.hash === 'string' &&
    candidate.transaction.hash.length > 0
  ) {
    return candidate.transaction.hash;
  }
  return undefined;
}

async function submitTrackedDepositTransaction(params: {
  multiProvider: MultiProvider;
  originChain: string;
  transaction: PopulatedTransaction;
  approvalTxHashes: string[];
  persistence: DepositPersistenceContext;
}): Promise<string> {
  const {
    multiProvider,
    originChain,
    transaction,
    approvalTxHashes,
    persistence,
  } = params;
  const { stateStore } = persistence;

  const signer = multiProvider.getSigner(originChain);
  const rawNonce =
    typeof signer.getTransactionCount === 'function'
      ? await signer.getTransactionCount('latest')
      : undefined;
  const originNonce = typeof rawNonce === 'number' ? rawNonce : undefined;

  const now = Date.now();
  let attempt: PersistedBridgeAttempt = {
    originChain,
    destinationChain: persistence.destinationChain,
    recipient: persistence.recipient,
    funderAddress: persistence.funderAddress,
    stack: persistence.bridge.stack,
    mode: persistence.bridge.mode,
    bridgedAmount: persistence.bridgedDestinationAmount.toString(),
    baselineDestinationBalance:
      persistence.baselineDestinationBalance.toString(),
    originNonce,
    approvalTxHashes: [...approvalTxHashes],
    phase: 'prepared',
    createdAtMs: now,
    updatedAtMs: now,
  };

  if (stateStore) {
    await stateStore.set(attempt);
  }

  try {
    const receipt = await multiProvider.sendTransaction(
      originChain,
      transaction,
      {
        onSubmissionAttempt: async (txHash?: string) => {
          if (txHash && stateStore) {
            attempt = {
              ...attempt,
              depositTxHash: txHash,
              updatedAtMs: Date.now(),
            };
            await stateStore.set(attempt);
          }
        },
        onSubmitted: async (txHash: string) => {
          attempt = {
            ...attempt,
            phase: 'submitted',
            depositTxHash: txHash,
            updatedAtMs: Date.now(),
          };
          if (stateStore) {
            await stateStore.set(attempt);
          }
        },
      },
    );

    if (receipt.status === 0) {
      if (stateStore) {
        await stateStore.delete(
          persistence.destinationChain,
          persistence.recipient,
        );
      }
      throw new Error(
        `Origin bridge deposit transaction ${receipt.transactionHash} reverted on ${originChain}`,
      );
    }

    if (stateStore) {
      attempt = {
        ...attempt,
        phase: 'confirmed',
        depositTxHash: receipt.transactionHash,
        updatedAtMs: Date.now(),
      };
      await stateStore.set(attempt);
    }

    return receipt.transactionHash;
  } catch (error) {
    if (stateStore) {
      if (error instanceof TransactionSubmissionError) {
        if (
          error.submissionState === 'not_submitted' &&
          !attempt.depositTxHash &&
          !error.txHash
        ) {
          await stateStore.delete(
            persistence.destinationChain,
            persistence.recipient,
          );
        } else {
          attempt = {
            ...attempt,
            phase:
              error.submissionState === 'submitted'
                ? 'submitted'
                : attempt.phase,
            depositTxHash: error.txHash ?? attempt.depositTxHash,
            updatedAtMs: Date.now(),
          };
          await stateStore.set(attempt);
        }
      } else {
        const attachedHash = extractAttachedTxHash(error);
        if (attachedHash) {
          attempt = {
            ...attempt,
            phase: 'submitted',
            depositTxHash: attachedHash,
            updatedAtMs: Date.now(),
          };
          await stateStore.set(attempt);
        }
      }
    }
    throw error;
  }
}

async function dispatchViaHyperlaneHook(params: {
  multiProvider: MultiProvider;
  originChain: string;
  destinationChain: string;
  recipient: string;
  amount: BigNumber;
  reserveBuffer: string;
  hookDelivery: HyperlaneHookBridgeDelivery;
  persistence: DepositPersistenceContext;
}): Promise<string> {
  const {
    multiProvider,
    originChain,
    destinationChain,
    recipient,
    amount,
    reserveBuffer,
    hookDelivery,
    persistence,
  } = params;

  const originProvider = multiProvider.getProvider(originChain);
  const destinationProvider = multiProvider.getProvider(destinationChain);

  await Promise.all([
    assertDeployedContract(
      destinationProvider,
      destinationChain,
      hookDelivery.recipientAddress,
      'Hyperlane hook recipient contract',
    ),
    assertDeployedContract(
      originProvider,
      originChain,
      hookDelivery.mailboxAddress,
      'Hyperlane Mailbox contract',
    ),
    assertDeployedContract(
      originProvider,
      originChain,
      hookDelivery.hookAddress,
      'Hyperlane post-dispatch hook contract',
    ),
  ]);

  const funderAddress = await multiProvider.getSignerAddress(originChain);

  return withOriginSignerLock(originChain, funderAddress, async () => {
    const metadata = formatStandardHookMetadata({
      msgValue: amount,
      gasLimit: hookDelivery.gasLimit,
      refundAddress: funderAddress,
    });
    const dispatchRecipientBytes32 = ethers.utils.hexZeroPad(
      hookDelivery.recipientAddress,
      32,
    );
    // Encode the target key address so the payable IMessageRecipient forwarder
    // contract on the destination chain forwards the released funds to the key.
    const messageBody = ethers.utils.hexZeroPad(recipient, 32);

    const quoteData = BRIDGE_INTERFACES.hyperlaneMailbox.encodeFunctionData(
      'quoteDispatch',
      [
        hookDelivery.destinationDomain,
        dispatchRecipientBytes32,
        messageBody,
        metadata,
        hookDelivery.hookAddress,
      ],
    );
    const rawQuote = await originProvider.call({
      to: hookDelivery.mailboxAddress,
      data: quoteData,
    });
    const [quotedFee] = BRIDGE_INTERFACES.hyperlaneMailbox.decodeFunctionResult(
      'quoteDispatch',
      rawQuote,
    ) as [BigNumber];
    assert(
      quotedFee.gte(amount),
      `Mailbox quoteDispatch returned ${quotedFee.toString()}, less than bridged value ${amount.toString()}`,
    );

    const data = BRIDGE_INTERFACES.hyperlaneMailbox.encodeFunctionData(
      'dispatch',
      [
        hookDelivery.destinationDomain,
        dispatchRecipientBytes32,
        messageBody,
        metadata,
        hookDelivery.hookAddress,
      ],
    );

    const { transaction: preparedTx, gasCost } =
      await populateOriginTxWithGasCost(multiProvider, originChain, {
        to: hookDelivery.mailboxAddress,
        value: quotedFee,
        data,
      });

    await assertOriginNativeReserve({
      multiProvider,
      originChain,
      requiredValue: quotedFee,
      gasCost,
      reserveBufferStr: reserveBuffer,
    });

    return submitTrackedDepositTransaction({
      multiProvider,
      originChain,
      transaction: preparedTx,
      approvalTxHashes: [],
      persistence,
    });
  });
}

async function executeOpStackBridge(params: {
  multiProvider: MultiProvider;
  destinationChain: string;
  bridge: OpStackBridgeConfig;
  recipient: string;
  amount: BigNumber;
  persistence: DepositPersistenceContext;
}): Promise<string[]> {
  const {
    multiProvider,
    destinationChain,
    bridge,
    recipient,
    amount,
    persistence,
  } = params;

  if (bridge.mode === 'hyperlaneHook') {
    assert(bridge.hookDelivery, 'Missing hookDelivery for OP Stack hook mode');
    const txHash = await dispatchViaHyperlaneHook({
      multiProvider,
      originChain: bridge.originChain,
      destinationChain,
      recipient,
      amount,
      reserveBuffer: bridge.originReserveBuffer,
      hookDelivery: bridge.hookDelivery,
      persistence,
    });
    return [txHash];
  }

  const bridgeContract = bridge.bridgeContract;
  assert(
    bridgeContract,
    'Missing bridgeContract for OP Stack canonical bridge mode',
  );
  await assertDeployedContract(
    multiProvider.getProvider(bridge.originChain),
    bridge.originChain,
    bridgeContract,
    'OP Stack bridge contract',
  );

  const funderAddress = await multiProvider.getSignerAddress(
    bridge.originChain,
  );

  const txHash = await withOriginSignerLock(
    bridge.originChain,
    funderAddress,
    async () => {
      const data =
        bridge.mode === 'optimismPortal'
          ? BRIDGE_INTERFACES.optimismPortal.encodeFunctionData(
              'depositTransaction',
              [recipient, amount, bridge.l2GasLimit, false, '0x'],
            )
          : BRIDGE_INTERFACES.l1StandardBridge.encodeFunctionData(
              'depositETHTo',
              [recipient, bridge.l2GasLimit, '0x'],
            );

      const { transaction: preparedTx, gasCost } =
        await populateOriginTxWithGasCost(multiProvider, bridge.originChain, {
          to: bridgeContract,
          value: amount,
          data,
        });

      await assertOriginNativeReserve({
        multiProvider,
        originChain: bridge.originChain,
        requiredValue: amount,
        gasCost,
        reserveBufferStr: bridge.originReserveBuffer,
      });

      return submitTrackedDepositTransaction({
        multiProvider,
        originChain: bridge.originChain,
        transaction: preparedTx,
        approvalTxHashes: [],
        persistence,
      });
    },
  );

  return [txHash];
}

async function executeArbitrumOrbitBridge(params: {
  multiProvider: MultiProvider;
  destinationChain: string;
  bridge: ArbitrumOrbitBridgeConfig;
  recipient: string;
  amount: BigNumber;
  originDecimals: number;
  persistence: DepositPersistenceContext;
}): Promise<string[]> {
  const {
    multiProvider,
    destinationChain,
    bridge,
    recipient,
    amount,
    originDecimals,
    persistence,
  } = params;

  if (bridge.mode === 'hyperlaneHook') {
    assert(
      bridge.hookDelivery,
      'Missing hookDelivery for Arbitrum Orbit hook mode',
    );
    const txHash = await dispatchViaHyperlaneHook({
      multiProvider,
      originChain: bridge.originChain,
      destinationChain,
      recipient,
      amount,
      reserveBuffer: bridge.originReserveBuffer,
      hookDelivery: bridge.hookDelivery,
      persistence,
    });
    return [txHash];
  }

  const inboxAddress = bridge.inboxAddress;
  assert(
    inboxAddress,
    'Missing inboxAddress for Arbitrum Orbit canonical Inbox mode',
  );
  const originProvider = multiProvider.getProvider(bridge.originChain);
  await assertDeployedContract(
    originProvider,
    bridge.originChain,
    inboxAddress,
    'Arbitrum Orbit Inbox contract',
  );

  const funderAddress = await multiProvider.getSignerAddress(
    bridge.originChain,
  );

  if (bridge.mode === 'erc20Inbox') {
    const originGasToken = bridge.originGasToken;
    assert(
      originGasToken,
      'Missing originGasToken for Arbitrum Orbit erc20Inbox mode',
    );
    await assertDeployedContract(
      originProvider,
      bridge.originChain,
      originGasToken.address,
      'Arbitrum Orbit origin ERC20 gas token',
    );

    return withOriginSignerLock(bridge.originChain, funderAddress, async () => {
      const isSelfDeposit = eqAddress(recipient, funderAddress);
      const l2CallValue18 = scaleUnitsFloor(amount, originDecimals, 18);
      const maxSubmissionCost = BigNumber.from(bridge.maxSubmissionCostWei);
      const maxFeePerGas = BigNumber.from(bridge.maxFeePerGasWei);
      const l2TotalFee18 = l2CallValue18
        .add(maxSubmissionCost)
        .add(BigNumber.from(bridge.l2GasLimit).mul(maxFeePerGas));

      const requiredTokenAmount = isSelfDeposit
        ? amount
        : scaleUnitsCeil(l2TotalFee18, 18, originDecimals);

      const token = ERC20__factory.connect(
        originGasToken.address,
        originProvider,
      );
      const tokenBalance = await token.balanceOf(funderAddress);
      if (tokenBalance.lt(requiredTokenAmount)) {
        throw new Error(
          `Insufficient ERC20 gas token balance on ${bridge.originChain}: has ${ethers.utils.formatUnits(tokenBalance, originDecimals)}, needs ${ethers.utils.formatUnits(requiredTokenAmount, originDecimals)}`,
        );
      }

      const approvalTxHashes: string[] = [];
      const allowance = await token.allowance(funderAddress, inboxAddress);
      if (allowance.lt(requiredTokenAmount)) {
        if (!allowance.isZero()) {
          const resetRawTx = await token.populateTransaction.approve(
            inboxAddress,
            BigNumber.from(0),
          );
          const {
            transaction: resetPreparedTx,
            gasCost: resetGasCost,
            feePerGas: resetFeePerGas,
          } = await populateOriginTxWithGasCost(
            multiProvider,
            bridge.originChain,
            resetRawTx,
          );
          const preflightGasBudget = resetGasCost
            .add(ERC20_APPROVE_GAS_ESTIMATE.mul(resetFeePerGas))
            .add(ERC20_INBOX_DEPOSIT_GAS_ESTIMATE.mul(resetFeePerGas));

          await assertOriginNativeReserve({
            multiProvider,
            originChain: bridge.originChain,
            requiredValue: BigNumber.from(0),
            gasCost: preflightGasBudget,
            reserveBufferStr: bridge.originReserveBuffer,
          });

          const resetReceipt = await multiProvider.sendTransaction(
            bridge.originChain,
            resetPreparedTx,
          );
          approvalTxHashes.push(resetReceipt.transactionHash);
        }

        const approveRawTx = await token.populateTransaction.approve(
          inboxAddress,
          requiredTokenAmount,
        );
        const {
          transaction: approvePreparedTx,
          gasCost: approveGasCost,
          feePerGas: approveFeePerGas,
        } = await populateOriginTxWithGasCost(
          multiProvider,
          bridge.originChain,
          approveRawTx,
        );

        await assertOriginNativeReserve({
          multiProvider,
          originChain: bridge.originChain,
          requiredValue: BigNumber.from(0),
          gasCost: approveGasCost.add(
            ERC20_INBOX_DEPOSIT_GAS_ESTIMATE.mul(approveFeePerGas),
          ),
          reserveBufferStr: bridge.originReserveBuffer,
        });

        const approveReceipt = await multiProvider.sendTransaction(
          bridge.originChain,
          approvePreparedTx,
        );
        approvalTxHashes.push(approveReceipt.transactionHash);
      }

      const depositData = isSelfDeposit
        ? BRIDGE_INTERFACES.arbitrumErc20Inbox.encodeFunctionData(
            'depositERC20',
            [amount],
          )
        : BRIDGE_INTERFACES.arbitrumErc20Inbox.encodeFunctionData(
            'createRetryableTicket',
            [
              recipient,
              l2CallValue18,
              maxSubmissionCost,
              funderAddress,
              funderAddress,
              bridge.l2GasLimit,
              maxFeePerGas,
              requiredTokenAmount,
              '0x',
            ],
          );

      const { transaction: depositPreparedTx, gasCost: depositGasCost } =
        await populateOriginTxWithGasCost(multiProvider, bridge.originChain, {
          to: inboxAddress,
          value: BigNumber.from(0),
          data: depositData,
        });

      await assertOriginNativeReserve({
        multiProvider,
        originChain: bridge.originChain,
        requiredValue: BigNumber.from(0),
        gasCost: depositGasCost,
        reserveBufferStr: bridge.originReserveBuffer,
      });

      const depositTxHash = await submitTrackedDepositTransaction({
        multiProvider,
        originChain: bridge.originChain,
        transaction: depositPreparedTx,
        approvalTxHashes,
        persistence,
      });

      return [...approvalTxHashes, depositTxHash];
    });
  }

  return withOriginSignerLock(bridge.originChain, funderAddress, async () => {
    if (bridge.mode === 'ethInbox' && eqAddress(recipient, funderAddress)) {
      const data =
        BRIDGE_INTERFACES.arbitrumInbox.encodeFunctionData('depositEth');
      const { transaction: preparedTx, gasCost } =
        await populateOriginTxWithGasCost(multiProvider, bridge.originChain, {
          to: inboxAddress,
          value: amount,
          data,
        });

      await assertOriginNativeReserve({
        multiProvider,
        originChain: bridge.originChain,
        requiredValue: amount,
        gasCost,
        reserveBufferStr: bridge.originReserveBuffer,
      });

      const txHash = await submitTrackedDepositTransaction({
        multiProvider,
        originChain: bridge.originChain,
        transaction: preparedTx,
        approvalTxHashes: [],
        persistence,
      });
      return [txHash];
    }

    // Direct recipient funding (or ethInbox when recipient differs from origin signer)
    // uses createRetryableTicket so L2 value lands directly at the recipient address.
    const maxSubmissionCost = BigNumber.from(bridge.maxSubmissionCostWei);
    const maxFeePerGas = BigNumber.from(bridge.maxFeePerGasWei);
    const totalCallValue = amount
      .add(maxSubmissionCost)
      .add(BigNumber.from(bridge.l2GasLimit).mul(maxFeePerGas));

    const data = BRIDGE_INTERFACES.arbitrumInbox.encodeFunctionData(
      'createRetryableTicket',
      [
        recipient,
        amount,
        maxSubmissionCost,
        funderAddress,
        funderAddress,
        bridge.l2GasLimit,
        maxFeePerGas,
        '0x',
      ],
    );

    const { transaction: preparedTx, gasCost } =
      await populateOriginTxWithGasCost(multiProvider, bridge.originChain, {
        to: inboxAddress,
        value: totalCallValue,
        data,
      });

    await assertOriginNativeReserve({
      multiProvider,
      originChain: bridge.originChain,
      requiredValue: totalCallValue,
      gasCost,
      reserveBufferStr: bridge.originReserveBuffer,
    });

    const txHash = await submitTrackedDepositTransaction({
      multiProvider,
      originChain: bridge.originChain,
      transaction: preparedTx,
      approvalTxHashes: [],
      persistence,
    });
    return [txHash];
  });
}

export async function bridgeKeyFunding(params: {
  multiProvider: MultiProvider;
  destinationChain: string;
  bridge: BridgeConfig;
  recipient: string;
  shortfallAmount: BigNumber;
  destinationDecimals: number;
  baselineDestinationBalance?: BigNumber;
  stateStore?: BridgeStateStore;
  recipientLockHeld?: boolean;
  logger: Logger;
}): Promise<BridgeFundingResult | null> {
  const {
    multiProvider,
    destinationChain,
    bridge,
    recipient,
    shortfallAmount,
    destinationDecimals,
    baselineDestinationBalance,
    stateStore,
    recipientLockHeld,
    logger,
  } = params;

  const run = async (): Promise<BridgeFundingResult | null> => {
    const currentDestBalance =
      baselineDestinationBalance ??
      (await multiProvider.getProvider(destinationChain).getBalance(recipient));

    if (stateStore) {
      const activeAttempt = await reconcilePendingBridgeAttempt({
        multiProvider,
        stateStore,
        destinationChain,
        recipient,
        currentDestinationBalance: currentDestBalance,
        logger,
      });
      if (activeAttempt) {
        logger.info(
          {
            originChain: activeAttempt.originChain,
            destinationChain,
            depositTxHash: activeAttempt.depositTxHash,
            phase: activeAttempt.phase,
          },
          'Pending bridge transfer still in transit for recipient, skipping duplicate bridge',
        );
        return null;
      }
    }

    const originDecimals = getBridgeDecimals(bridge, destinationDecimals);
    const minThresholdOrigin = ethers.utils.parseUnits(
      bridge.minBridgeThreshold,
      originDecimals,
    );

    const commonDecimals = Math.max(destinationDecimals, originDecimals);
    const shortfallCommon = scaleUnitsFloor(
      shortfallAmount,
      destinationDecimals,
      commonDecimals,
    );
    const minThresholdCommon = scaleUnitsFloor(
      minThresholdOrigin,
      originDecimals,
      commonDecimals,
    );

    if (shortfallCommon.lt(minThresholdCommon)) {
      logger.warn(
        {
          shortfall: ethers.utils.formatUnits(
            shortfallAmount,
            destinationDecimals,
          ),
          minBridgeThreshold: bridge.minBridgeThreshold,
        },
        'Bridge shortfall below minBridgeThreshold, skipping cross-chain bridge',
      );
      return null;
    }

    const maxAmountOrigin = ethers.utils.parseUnits(
      bridge.maxBridgeAmount,
      originDecimals,
    );
    const shortfallOrigin = scaleUnitsCeil(
      shortfallAmount,
      destinationDecimals,
      originDecimals,
    );
    const bridgedOriginAmount = shortfallOrigin.gt(maxAmountOrigin)
      ? maxAmountOrigin
      : shortfallOrigin;
    const bridgedDestinationAmount = scaleUnitsFloor(
      bridgedOriginAmount,
      originDecimals,
      destinationDecimals,
    );

    const funderAddress = await multiProvider.getSignerAddress(
      bridge.originChain,
    );

    logger.info(
      {
        originChain: bridge.originChain,
        destinationChain,
        stack: bridge.stack,
        mode: bridge.mode,
        recipient,
        bridgedAmount: ethers.utils.formatUnits(
          bridgedOriginAmount,
          originDecimals,
        ),
      },
      'Bridging funds from origin chain',
    );

    const persistence: DepositPersistenceContext = {
      stateStore,
      destinationChain,
      recipient,
      funderAddress,
      bridge,
      bridgedDestinationAmount,
      baselineDestinationBalance: currentDestBalance,
    };

    const txHashes =
      bridge.stack === 'opStack'
        ? await executeOpStackBridge({
            multiProvider,
            destinationChain,
            bridge,
            recipient,
            amount: bridgedOriginAmount,
            persistence,
          })
        : await executeArbitrumOrbitBridge({
            multiProvider,
            destinationChain,
            bridge,
            recipient,
            amount: bridgedOriginAmount,
            originDecimals,
            persistence,
          });

    logger.info(
      {
        originChain: bridge.originChain,
        destinationChain,
        txHashes,
      },
      'Cross-chain bridge funding submitted',
    );

    return { bridgedAmount: bridgedDestinationAmount, txHashes };
  };

  return recipientLockHeld
    ? run()
    : withRecipientBridgeLock(destinationChain, recipient, run);
}
