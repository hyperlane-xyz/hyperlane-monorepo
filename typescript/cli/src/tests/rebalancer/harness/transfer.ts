import {
  ERC20__factory,
  HypERC20Collateral__factory,
  HypERC20__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { RebalancerTestSetup } from './setup.js';

export interface TransferResult {
  messageId: string;
  txHash: string;
  message: string;
}

/**
 * Execute a warp transfer and relay the message to the destination.
 *
 * Since all domains are on the same anvil instance, we can relay
 * by directly calling process() on the destination mailbox.
 *
 * @param setup The test setup object
 * @param originDomain Origin domain name
 * @param destDomain Destination domain name
 * @param amount Amount to transfer (in wei)
 * @returns Transfer result with messageId and txHash
 */
export async function transferAndRelay(
  setup: RebalancerTestSetup,
  originDomain: string,
  destDomain: string,
  amount: bigint,
): Promise<TransferResult> {
  const { signer } = setup;

  const origin = setup.getDomain(originDomain);
  const dest = setup.getDomain(destDomain);

  const originWarpAddress = setup.getWarpRouteAddress(originDomain);

  // Check if origin is collateral (has token)
  const originToken = setup.tokens[originDomain];
  const isCollateral = !!originToken;

  // If origin is collateral, approve tokens
  if (isCollateral) {
    const token = ERC20__factory.connect(originToken.address, signer);
    await (await token.approve(originWarpAddress, amount)).wait();
  }

  // Get warp route contract
  const warpRoute = isCollateral
    ? HypERC20Collateral__factory.connect(originWarpAddress, signer)
    : HypERC20__factory.connect(originWarpAddress, signer);

  // Get recipient (use deployer address)
  const recipient = addressToBytes32(signer.address);

  // Get quote for gas payment
  const quote = await warpRoute.quoteGasPayment(dest.domainId);

  // Execute transfer
  const tx = await warpRoute.transferRemote(dest.domainId, recipient, amount, {
    value: quote,
  });
  const receipt = await tx.wait();

  // Get mailbox to parse events
  const originMailbox = Mailbox__factory.connect(origin.mailbox, signer);

  // Extract message from Dispatch event
  const dispatchLog = receipt.logs
    .map((log) => {
      try {
        return originMailbox.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((e) => e?.name === 'Dispatch');

  if (!dispatchLog) {
    throw new Error('Dispatch event not found in transaction receipt');
  }

  const message = dispatchLog.args.message;

  // Extract messageId from DispatchId event
  const dispatchIdLog = receipt.logs
    .map((log) => {
      try {
        return originMailbox.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((e) => e?.name === 'DispatchId');

  if (!dispatchIdLog) {
    throw new Error('DispatchId event not found in transaction receipt');
  }

  const messageId = dispatchIdLog.args.messageId;

  // Relay message to destination by calling process on destination mailbox
  // With TestISM, we don't need any metadata
  const destMailbox = Mailbox__factory.connect(dest.mailbox, signer);
  await (await destMailbox.process('0x', message)).wait();

  return {
    messageId,
    txHash: receipt.transactionHash,
    message,
  };
}

/**
 * Get the current collateral balance of a warp route.
 *
 * For collateral domains, this returns the underlying token balance.
 * For synthetic domains, this returns 0.
 *
 * @param setup The test setup object
 * @param domainName Domain name
 * @returns Balance in wei
 */
export async function getWarpRouteBalance(
  setup: RebalancerTestSetup,
  domainName: string,
): Promise<bigint> {
  const token = setup.tokens[domainName];

  // Synthetic domains don't hold collateral
  if (!token) {
    return 0n;
  }

  const warpRouteAddress = setup.getWarpRouteAddress(domainName);
  const balance = await token.balanceOf(warpRouteAddress);

  return balance.toBigInt();
}

/**
 * Get all warp route balances across configured collateral domains.
 *
 * @param setup The test setup object
 * @returns Record of domain name to balance
 */
export async function getAllWarpRouteBalances(
  setup: RebalancerTestSetup,
): Promise<Record<string, bigint>> {
  const balances: Record<string, bigint> = {};

  for (const domainName of Object.keys(setup.tokens)) {
    balances[domainName] = await getWarpRouteBalance(setup, domainName);
  }

  return balances;
}

/**
 * Transfer tokens directly (not via warp) to simulate external deposits.
 *
 * @param setup The test setup object
 * @param domainName Domain to deposit to
 * @param amount Amount to deposit
 */
export async function depositCollateral(
  setup: RebalancerTestSetup,
  domainName: string,
  amount: bigint,
): Promise<void> {
  const token = setup.tokens[domainName];
  if (!token) {
    throw new Error(`No token found for domain ${domainName}`);
  }

  const warpRouteAddress = setup.getWarpRouteAddress(domainName);
  await (await token.transfer(warpRouteAddress, amount)).wait();
}

/**
 * Withdraw tokens directly (not via warp) to simulate external withdrawals.
 * Note: This requires the warp route to have a withdraw function or
 * manipulating storage directly for testing.
 *
 * For now, this creates an imbalance by transferring via warp to synthetic.
 *
 * @param setup The test setup object
 * @param domainName Domain to withdraw from
 * @param destDomain Destination domain (typically synthetic)
 * @param amount Amount to withdraw
 */
export async function withdrawCollateral(
  setup: RebalancerTestSetup,
  domainName: string,
  destDomain: string,
  amount: bigint,
): Promise<void> {
  await transferAndRelay(setup, domainName, destDomain, amount);
}
