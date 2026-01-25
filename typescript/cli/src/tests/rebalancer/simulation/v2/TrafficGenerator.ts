/**
 * TrafficGenerator
 *
 * Generates warp route transfer traffic by submitting real transactions.
 */
import { BigNumber } from 'ethers';

import {
  HypERC20Collateral__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import type { MultiProvider } from '@hyperlane-xyz/sdk';
import { Address, addressToBytes32, bytes32ToAddress } from '@hyperlane-xyz/utils';

import type { RebalancerTestSetup } from '../../harness/setup.js';
import type { PendingWarpTransfer, ScheduledTransfer } from './types.js';

/**
 * Result of executing a transfer.
 */
export interface TransferExecutionResult {
  /** Transaction hash */
  txHash: string;
  /** Hyperlane message ID */
  messageId: string;
  /** Block number */
  blockNumber: number;
}

/**
 * Generates warp route traffic by executing real transactions.
 */
export class TrafficGenerator {
  constructor(
    private readonly setup: RebalancerTestSetup,
    private readonly warpTransferDelayMs: number,
  ) {}

  /**
   * Execute a scheduled transfer.
   *
   * @param transfer The transfer to execute
   * @param currentTime Current simulation time
   * @returns Pending transfer info
   */
  async executeTransfer(
    transfer: ScheduledTransfer,
    currentTime: number,
  ): Promise<PendingWarpTransfer> {
    const { origin, destination, amount, sender } = transfer;

    // Get warp route contract
    const warpRouteAddress = this.setup.getWarpRouteAddress(origin);
    const warpRoute = HypERC20Collateral__factory.connect(
      warpRouteAddress,
      this.setup.signer,
    );

    // Get destination domain ID
    const destDomain = this.setup.getDomain(destination).domainId;

    // Determine recipient (sender on destination, or specified sender)
    const recipientAddress = sender ?? this.setup.signer.address;
    const recipientBytes32 = addressToBytes32(recipientAddress);

    // If this is a collateral route, we need to approve and have tokens
    // For now, assume the signer has tokens (from test setup)
    const token = this.setup.tokens[origin];
    if (token) {
      // Approve warp route to spend tokens
      const allowance = await token.allowance(
        this.setup.signer.address,
        warpRouteAddress,
      );
      if (allowance.lt(amount)) {
        const approveTx = await token.approve(
          warpRouteAddress,
          BigNumber.from(amount).mul(10), // Approve extra for future transfers
        );
        await approveTx.wait();
      }
    }

    // Get quote for gas payment
    const quote = await warpRoute.quoteGasPayment(destDomain);

    // Execute transfer
    const tx = await warpRoute.transferRemote(
      destDomain,
      recipientBytes32,
      amount,
      { value: quote },
    );
    const receipt = await tx.wait();

    // Extract message ID from dispatch event
    const messageId = this.extractMessageId(receipt);

    return {
      messageId,
      txHash: tx.hash,
      origin,
      destination,
      amount,
      sender: this.setup.signer.address as Address,
      recipient: recipientAddress as Address,
      initiatedAt: currentTime,
      expectedCompletionAt: currentTime + this.warpTransferDelayMs,
      completed: false,
    };
  }

  /**
   * Process (deliver) a warp transfer by calling the destination mailbox.
   *
   * In the real world, this is done by relayers. In simulation, we do it
   * ourselves after the appropriate delay.
   *
   * @param pending The pending transfer to complete
   */
  async deliverTransfer(pending: PendingWarpTransfer): Promise<void> {
    const destDomain = this.setup.getDomain(pending.destination);
    const originDomain = this.setup.getDomain(pending.origin);

    // Get the message from the dispatch event
    // For TestISM, we can process any message directly
    const mailbox = Mailbox__factory.connect(
      destDomain.mailbox,
      this.setup.signer,
    );

    // Build the message
    // Format: version (1) + nonce (4) + origin (4) + sender (32) + dest (4) + recipient (32) + body
    const warpRouteOrigin = this.setup.getWarpRouteAddress(pending.origin);
    const warpRouteDest = this.setup.getWarpRouteAddress(pending.destination);

    // The message body for warp routes is: recipient (32 bytes) + amount (32 bytes)
    const messageBody = this.encodeTokenMessage(
      pending.recipient,
      pending.amount,
    );

    // Construct the full Hyperlane message
    const message = this.encodeHyperlaneMessage({
      version: 3,
      nonce: 0, // TestISM doesn't validate nonce
      originDomain: originDomain.domainId,
      sender: addressToBytes32(warpRouteOrigin),
      destinationDomain: destDomain.domainId,
      recipient: addressToBytes32(warpRouteDest),
      body: messageBody,
    });

    // Process the message (TestISM accepts any message)
    const processTx = await mailbox.process('0x', message);
    await processTx.wait();
  }

  /**
   * Extract message ID from a transfer transaction receipt.
   */
  private extractMessageId(receipt: any): string {
    // Look for Dispatch event from mailbox
    // Topic[0] is the event signature: Dispatch(address,uint32,bytes32,bytes)
    const dispatchTopic =
      '0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814';

    for (const log of receipt.logs) {
      if (log.topics[0] === dispatchTopic) {
        // Message ID is topic[3]
        return log.topics[3];
      }
    }

    throw new Error('Dispatch event not found in receipt');
  }

  /**
   * Encode a TokenMessage body.
   */
  private encodeTokenMessage(recipient: Address, amount: bigint): string {
    // TokenMessage format: bytes32 recipient + uint256 amount
    const recipientBytes32 = addressToBytes32(recipient).slice(2); // Remove 0x
    const amountHex = amount.toString(16).padStart(64, '0');
    return '0x' + recipientBytes32 + amountHex;
  }

  /**
   * Encode a full Hyperlane message.
   */
  private encodeHyperlaneMessage(params: {
    version: number;
    nonce: number;
    originDomain: number;
    sender: string;
    destinationDomain: number;
    recipient: string;
    body: string;
  }): string {
    const { version, nonce, originDomain, sender, destinationDomain, recipient, body } = params;

    // Format: version (1) + nonce (4) + origin (4) + sender (32) + dest (4) + recipient (32) + body
    const versionHex = version.toString(16).padStart(2, '0');
    const nonceHex = nonce.toString(16).padStart(8, '0');
    const originHex = originDomain.toString(16).padStart(8, '0');
    const senderHex = sender.slice(2); // Remove 0x, already 64 chars
    const destHex = destinationDomain.toString(16).padStart(8, '0');
    const recipientHex = recipient.slice(2); // Remove 0x, already 64 chars
    const bodyHex = body.slice(2); // Remove 0x

    return '0x' + versionHex + nonceHex + originHex + senderHex + destHex + recipientHex + bodyHex;
  }
}
