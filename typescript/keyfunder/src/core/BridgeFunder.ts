import { BigNumber, ethers } from 'ethers';
import type { PopulatedTransaction } from 'ethers';
import type { Logger } from 'pino';

import { ERC20__factory } from '@hyperlane-xyz/core';
import type { MultiProvider } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import type {
  ArbitrumOrbitBridgeConfig,
  BridgeConfig,
  HyperlaneHookBridgeDelivery,
  OpStackBridgeConfig,
} from '../config/types.js';

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
  ]),
  hyperlaneMailbox: new ethers.utils.Interface([
    'function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes messageBody, bytes customHookMetadata, address customHook) payable returns (bytes32)',
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

async function assertOriginNativeReserve(
  multiProvider: MultiProvider,
  originChain: string,
  requiredValue: BigNumber,
  reserveBufferStr: string,
  decimals: number,
): Promise<void> {
  const signer = multiProvider.getSigner(originChain);
  const originBalance = await signer.getBalance();
  const reserveBuffer = ethers.utils.parseUnits(reserveBufferStr, decimals);
  const totalRequired = requiredValue.add(reserveBuffer);
  if (originBalance.lt(totalRequired)) {
    throw new Error(
      `Insufficient origin balance on ${originChain}: has ${ethers.utils.formatUnits(originBalance, decimals)}, needs ${ethers.utils.formatUnits(totalRequired, decimals)} (including reserve buffer)`,
    );
  }
}

async function dispatchViaHyperlaneHook(params: {
  multiProvider: MultiProvider;
  originChain: string;
  recipient: string;
  amount: BigNumber;
  reserveBuffer: string;
  decimals: number;
  hookDelivery: HyperlaneHookBridgeDelivery;
}): Promise<string> {
  const {
    multiProvider,
    originChain,
    recipient,
    amount,
    reserveBuffer,
    decimals,
    hookDelivery,
  } = params;
  const funderAddress = await multiProvider.getSignerAddress(originChain);
  const metadata = formatStandardHookMetadata({
    msgValue: amount,
    gasLimit: hookDelivery.gasLimit,
    refundAddress: funderAddress,
  });

  let hookFee = amount;
  try {
    const hookContract = new ethers.Contract(
      hookDelivery.hookAddress,
      BRIDGE_INTERFACES.hyperlanePostDispatchHook,
      multiProvider.getProvider(originChain),
    );
    const quoted: BigNumber = await hookContract.quoteDispatch(metadata, '0x');
    if (quoted.gt(hookFee)) {
      hookFee = quoted;
    }
  } catch {
    // Fall back to msgValue when the hook contract does not expose quoteDispatch or is mocked.
  }

  await assertOriginNativeReserve(
    multiProvider,
    originChain,
    hookFee,
    reserveBuffer,
    decimals,
  );

  const recipientBytes32 = ethers.utils.hexZeroPad(recipient, 32);
  const data = BRIDGE_INTERFACES.hyperlaneMailbox.encodeFunctionData(
    'dispatch',
    [
      hookDelivery.destinationDomain,
      recipientBytes32,
      '0x',
      metadata,
      hookDelivery.hookAddress,
    ],
  );

  const receipt = await multiProvider.sendTransaction(originChain, {
    to: hookDelivery.mailboxAddress,
    value: hookFee,
    data,
  });
  return receipt.transactionHash;
}

async function executeOpStackBridge(params: {
  multiProvider: MultiProvider;
  bridge: OpStackBridgeConfig;
  recipient: string;
  amount: BigNumber;
  decimals: number;
}): Promise<string[]> {
  const { multiProvider, bridge, recipient, amount, decimals } = params;

  if (bridge.mode === 'hyperlaneHook') {
    assert(bridge.hookDelivery, 'Missing hookDelivery for OP Stack hook mode');
    const txHash = await dispatchViaHyperlaneHook({
      multiProvider,
      originChain: bridge.originChain,
      recipient,
      amount,
      reserveBuffer: bridge.originReserveBuffer,
      decimals,
      hookDelivery: bridge.hookDelivery,
    });
    return [txHash];
  }

  assert(
    bridge.bridgeContract,
    'Missing bridgeContract for OP Stack canonical bridge mode',
  );
  await assertOriginNativeReserve(
    multiProvider,
    bridge.originChain,
    amount,
    bridge.originReserveBuffer,
    decimals,
  );

  const data =
    bridge.mode === 'optimismPortal'
      ? BRIDGE_INTERFACES.optimismPortal.encodeFunctionData(
          'depositTransaction',
          [recipient, amount, bridge.l2GasLimit, false, '0x'],
        )
      : BRIDGE_INTERFACES.l1StandardBridge.encodeFunctionData('depositETHTo', [
          recipient,
          bridge.l2GasLimit,
          '0x',
        ]);

  const tx: PopulatedTransaction = {
    to: bridge.bridgeContract,
    value: amount,
    data,
  };
  const receipt = await multiProvider.sendTransaction(bridge.originChain, tx);
  return [receipt.transactionHash];
}

async function executeArbitrumOrbitBridge(params: {
  multiProvider: MultiProvider;
  bridge: ArbitrumOrbitBridgeConfig;
  recipient: string;
  amount: BigNumber;
  decimals: number;
}): Promise<string[]> {
  const { multiProvider, bridge, recipient, amount, decimals } = params;

  if (bridge.mode === 'hyperlaneHook') {
    assert(
      bridge.hookDelivery,
      'Missing hookDelivery for Arbitrum Orbit hook mode',
    );
    const txHash = await dispatchViaHyperlaneHook({
      multiProvider,
      originChain: bridge.originChain,
      recipient,
      amount,
      reserveBuffer: bridge.originReserveBuffer,
      decimals,
      hookDelivery: bridge.hookDelivery,
    });
    return [txHash];
  }

  assert(
    bridge.inboxAddress,
    'Missing inboxAddress for Arbitrum Orbit canonical Inbox mode',
  );
  const funderAddress = await multiProvider.getSignerAddress(
    bridge.originChain,
  );

  if (bridge.mode === 'erc20Inbox') {
    assert(
      bridge.originGasToken,
      'Missing originGasToken for Arbitrum Orbit erc20Inbox mode',
    );
    await assertOriginNativeReserve(
      multiProvider,
      bridge.originChain,
      BigNumber.from(0),
      bridge.originReserveBuffer,
      18,
    );

    const token = ERC20__factory.connect(
      bridge.originGasToken.address,
      multiProvider.getProvider(bridge.originChain),
    );
    const tokenBalance = await token.balanceOf(funderAddress);
    if (tokenBalance.lt(amount)) {
      throw new Error(
        `Insufficient ERC20 gas token balance on ${bridge.originChain}: has ${ethers.utils.formatUnits(tokenBalance, decimals)}, needs ${ethers.utils.formatUnits(amount, decimals)}`,
      );
    }

    const txHashes: string[] = [];
    const allowance = await token.allowance(funderAddress, bridge.inboxAddress);
    if (allowance.lt(amount)) {
      const approveTx = await token.populateTransaction.approve(
        bridge.inboxAddress,
        amount,
      );
      const approveReceipt = await multiProvider.sendTransaction(
        bridge.originChain,
        approveTx,
      );
      txHashes.push(approveReceipt.transactionHash);
    }

    const depositData = BRIDGE_INTERFACES.arbitrumErc20Inbox.encodeFunctionData(
      'depositERC20',
      [amount],
    );
    const depositReceipt = await multiProvider.sendTransaction(
      bridge.originChain,
      {
        to: bridge.inboxAddress,
        value: BigNumber.from(0),
        data: depositData,
      },
    );
    txHashes.push(depositReceipt.transactionHash);
    return txHashes;
  }

  if (
    bridge.mode === 'ethInbox' &&
    recipient.toLowerCase() === funderAddress.toLowerCase()
  ) {
    await assertOriginNativeReserve(
      multiProvider,
      bridge.originChain,
      amount,
      bridge.originReserveBuffer,
      decimals,
    );
    const data =
      BRIDGE_INTERFACES.arbitrumInbox.encodeFunctionData('depositEth');
    const receipt = await multiProvider.sendTransaction(bridge.originChain, {
      to: bridge.inboxAddress,
      value: amount,
      data,
    });
    return [receipt.transactionHash];
  }

  // Direct recipient funding (or ethInbox when recipient differs from origin signer)
  // uses createRetryableTicket so L2 value lands directly at the recipient address.
  const maxSubmissionCost = BigNumber.from(bridge.maxSubmissionCostWei);
  const maxFeePerGas = BigNumber.from(bridge.maxFeePerGasWei);
  const totalCallValue = amount
    .add(maxSubmissionCost)
    .add(BigNumber.from(bridge.l2GasLimit).mul(maxFeePerGas));

  await assertOriginNativeReserve(
    multiProvider,
    bridge.originChain,
    totalCallValue,
    bridge.originReserveBuffer,
    decimals,
  );

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
  const receipt = await multiProvider.sendTransaction(bridge.originChain, {
    to: bridge.inboxAddress,
    value: totalCallValue,
    data,
  });
  return [receipt.transactionHash];
}

export async function bridgeKeyFunding(params: {
  multiProvider: MultiProvider;
  destinationChain: string;
  bridge: BridgeConfig;
  recipient: string;
  shortfallAmount: BigNumber;
  destinationDecimals: number;
  logger: Logger;
}): Promise<BridgeFundingResult | null> {
  const {
    multiProvider,
    destinationChain,
    bridge,
    recipient,
    shortfallAmount,
    destinationDecimals,
    logger,
  } = params;

  const decimals = getBridgeDecimals(bridge, destinationDecimals);
  const minThreshold = ethers.utils.parseUnits(
    bridge.minBridgeThreshold,
    decimals,
  );
  if (shortfallAmount.lt(minThreshold)) {
    logger.info(
      {
        shortfall: ethers.utils.formatUnits(shortfallAmount, decimals),
        minBridgeThreshold: bridge.minBridgeThreshold,
      },
      'Bridge shortfall below minBridgeThreshold, skipping cross-chain bridge',
    );
    return null;
  }

  const maxAmount = ethers.utils.parseUnits(bridge.maxBridgeAmount, decimals);
  const bridgedAmount = shortfallAmount.gt(maxAmount)
    ? maxAmount
    : shortfallAmount;

  logger.info(
    {
      originChain: bridge.originChain,
      destinationChain,
      stack: bridge.stack,
      mode: bridge.mode,
      recipient,
      bridgedAmount: ethers.utils.formatUnits(bridgedAmount, decimals),
    },
    'Bridging funds from origin chain',
  );

  const txHashes =
    bridge.stack === 'opStack'
      ? await executeOpStackBridge({
          multiProvider,
          bridge,
          recipient,
          amount: bridgedAmount,
          decimals,
        })
      : await executeArbitrumOrbitBridge({
          multiProvider,
          bridge,
          recipient,
          amount: bridgedAmount,
          decimals,
        });

  logger.info(
    {
      originChain: bridge.originChain,
      destinationChain,
      txHashes,
    },
    'Cross-chain bridge funding submitted',
  );

  return { bridgedAmount, txHashes };
}
