/**
 * get_pending_transfers tool — returns inflight user transfers awaiting delivery.
 */

import { Type } from '@sinclair/typebox';

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

import type { PendingTransferProvider } from '../pending-transfers.js';

const parameters = Type.Object({});

export function buildGetPendingTransfersTool(
  provider: PendingTransferProvider,
): ToolDefinition<typeof parameters> {
  return {
    name: 'get_pending_transfers',
    label: 'Get Pending Transfers',
    description:
      'Get inflight user transfers awaiting delivery. ' +
      'Returns pending transfers with origin, destination, and amount. ' +
      'Use alongside get_balances to detect collateral deficits.',
    parameters,
    async execute() {
      try {
        const transfers = await provider.getPendingTransfers();
        const text = JSON.stringify(
          { count: transfers.length, transfers },
          null,
          2,
        );
        return { content: [{ type: 'text' as const, text }], details: undefined };
      } catch (error) {
        const text = `Error fetching pending transfers: ${error instanceof Error ? error.message : String(error)}`;
        return { content: [{ type: 'text' as const, text }], details: undefined };
      }
    },
  };
}
