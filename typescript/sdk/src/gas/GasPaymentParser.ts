import type { TransactionReceipt } from '@ethersproject/providers';

import { InterchainGasPaymaster__factory } from '@hyperlane-xyz/core';
import { eqAddressEvm } from '@hyperlane-xyz/utils';

import type { InterchainGasPayment } from './types.js';

const IGP_INTERFACE = InterchainGasPaymaster__factory.createInterface();
const GAS_PAYMENT_TOPIC = IGP_INTERFACE.getEventTopic('GasPayment');

/**
 * Parse GasPayment events from a transaction receipt.
 *
 * @param receipt The transaction receipt to parse
 * @param igpAddress Optional IGP address to filter events by. If provided,
 *                   only events from this address will be returned.
 * @returns Array of parsed InterchainGasPayment objects
 */
export function parseGasPaymentsFromReceipt(
  receipt: TransactionReceipt,
  igpAddress?: string,
): InterchainGasPayment[] {
  return receipt.logs
    .filter((log) => {
      // Must be a GasPayment event
      if (log.topics[0] !== GAS_PAYMENT_TOPIC) {
        return false;
      }
      // If igpAddress is provided, filter by contract address
      if (igpAddress && !eqAddressEvm(log.address, igpAddress)) {
        return false;
      }
      return true;
    })
    .map((log) => {
      const parsed = IGP_INTERFACE.parseLog(log);
      return {
        messageId: parsed.args.messageId as string,
        destination: parsed.args.destinationDomain as number,
        gasAmount: BigInt(parsed.args.gasAmount.toString()),
        payment: BigInt(parsed.args.payment.toString()),
      };
    });
}

/**
 * Get the gas payment for a specific message from a list of payments.
 * If multiple payments exist for the same message, they are aggregated.
 *
 * @param payments Array of gas payments to search
 * @param messageId The message ID to find payment for
 * @param destination The destination domain
 * @returns The aggregated payment, or undefined if no payment found
 */
export function getGasPaymentForMessage(
  payments: InterchainGasPayment[],
  messageId: string,
  destination: number,
): InterchainGasPayment | undefined {
  const matching = payments.filter(
    (p) =>
      p.messageId.toLowerCase() === messageId.toLowerCase() &&
      p.destination === destination,
  );

  if (matching.length === 0) {
    return undefined;
  }

  return aggregateGasPayments(matching);
}

/**
 * Aggregate multiple gas payments into a single payment.
 * Sums the gasAmount and payment fields.
 *
 * @param payments Array of payments to aggregate (must be non-empty)
 * @returns Aggregated payment with summed amounts
 */
export function aggregateGasPayments(
  payments: InterchainGasPayment[],
): InterchainGasPayment {
  if (payments.length === 0) {
    throw new Error('Cannot aggregate empty payments array');
  }

  if (payments.length === 1) {
    return payments[0];
  }

  return payments.reduce(
    (acc, p) => ({
      messageId: acc.messageId,
      destination: acc.destination,
      gasAmount: acc.gasAmount + p.gasAmount,
      payment: acc.payment + p.payment,
    }),
    {
      messageId: payments[0].messageId,
      destination: payments[0].destination,
      gasAmount: BigInt(0),
      payment: BigInt(0),
    },
  );
}
