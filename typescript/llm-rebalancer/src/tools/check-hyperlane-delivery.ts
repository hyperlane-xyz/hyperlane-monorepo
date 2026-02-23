/**
 * check_hyperlane_delivery tool — checks if a Hyperlane message was delivered.
 */

import { Type, type Static } from '@sinclair/typebox';
import { ethers } from 'ethers';

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

import type { RebalancerAgentConfig } from '../config.js';

const parameters = Type.Object({
  messageId: Type.String({ description: 'Hyperlane message ID (bytes32 hex)' }),
  destinationChain: Type.String({ description: 'Destination chain name' }),
});

type Params = Static<typeof parameters>;

const MAILBOX_DELIVERED = ['function delivered(bytes32) view returns (bool)'];

export function buildCheckDeliveryTool(
  agentConfig: RebalancerAgentConfig,
): ToolDefinition<typeof parameters> {
  return {
    name: 'check_hyperlane_delivery',
    label: 'Check Delivery',
    description:
      'Check if a Hyperlane message has been delivered on the destination chain. ' +
      'Only checks Hyperlane message delivery — bridge-specific delivery (CCTP, LiFi, etc.) ' +
      'should be verified via the respective bridge skill.',
    parameters,
    async execute(_toolCallId: string, params: Params) {
      const chain = agentConfig.chains[params.destinationChain];
      if (!chain) {
        const text = `Unknown chain: ${params.destinationChain}. Available: ${Object.keys(agentConfig.chains).join(', ')}`;
        return { content: [{ type: 'text' as const, text }], details: undefined };
      }

      const provider = new ethers.providers.JsonRpcProvider(chain.rpcUrl);
      const mailbox = new ethers.Contract(chain.mailbox, MAILBOX_DELIVERED, provider);
      const delivered: boolean = await mailbox.delivered(params.messageId);

      const text = JSON.stringify({ messageId: params.messageId, destinationChain: params.destinationChain, delivered });
      return { content: [{ type: 'text' as const, text }], details: undefined };
    },
  };
}
