/**
 * get_chain_metadata tool — returns chain configuration metadata.
 */

import { Type, type Static } from '@sinclair/typebox';

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

import type { RebalancerAgentConfig } from '../config.js';

const parameters = Type.Object({
  chains: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Chain names to query. Defaults to all configured chains.',
    }),
  ),
});

type Params = Static<typeof parameters>;

export function buildGetChainMetadataTool(
  agentConfig: RebalancerAgentConfig,
): ToolDefinition<typeof parameters> {
  return {
    name: 'get_chain_metadata',
    label: 'Get Chain Metadata',
    description:
      'Get chain configuration metadata: RPC URLs, domain IDs, contract addresses, bridge info.',
    parameters,
    async execute(_toolCallId: string, params: Params) {
      const chainNames = params.chains ?? Object.keys(agentConfig.chains);
      const result: Record<string, object> = {};

      for (const name of chainNames) {
        const chain = agentConfig.chains[name];
        if (!chain) continue;
        result[name] = {
          chainName: chain.chainName,
          domainId: chain.domainId,
          rpcUrl: chain.rpcUrl,
          mailbox: chain.mailbox,
          warpToken: chain.warpToken,
          collateralToken: chain.collateralToken,
          bridge: chain.bridge,
          ...(chain.assets ? { assets: chain.assets } : {}),
        };
      }

      const text = JSON.stringify(result, null, 2);
      return { content: [{ type: 'text' as const, text }], details: undefined };
    },
  };
}
