/**
 * Metaswaps MCP server — exposes the SDK as tools for AI agents.
 *
 * Usage:
 *   HYP_KEY=0x<private-key> npx tsx src/mcp/server.ts
 *
 * Or register in your Claude Code config (.mcp.json):
 *   {
 *     "mcpServers": {
 *       "metaswaps": {
 *         "command": "npx",
 *         "args": ["tsx", "/path/to/metaswaps-sdk/src/mcp/server.ts"],
 *         "env": { "HYP_KEY": "0x..." }
 *       }
 *     }
 *   }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MetaswapsSDK } from '../sdk.js';
import { checkMessageDelivery } from '../swap/tracker.js';
import { SwapStatus } from '../swap/tracker.js';
import type { QuoteResponse } from '../client/schemas.js';

const sdk = new MetaswapsSDK({
  relayApiUrl: process.env.RELAY_API_URL,
});

const server = new McpServer({
  name: 'metaswaps',
  version: '0.1.0',
});

// ── chains ────────────────────────────────────────────────────────────────────

server.tool(
  'metaswaps_chains',
  'List all chains supported by the Hyperlane Universal Router for cross-chain swaps.',
  {},
  async () => {
    const chains = await sdk.chains();
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(chains, null, 2) },
      ],
    };
  },
);

// ── tokens ────────────────────────────────────────────────────────────────────

server.tool(
  'metaswaps_tokens',
  'List tokens available for cross-chain swapping. Optionally filter by chain ID or search term.',
  {
    chainId: z
      .number()
      .optional()
      .describe(
        'EVM chain ID to filter by (e.g. 8453 for Base). Mapped to the "chain" field internally.',
      ),
    search: z.string().optional().describe('Search by token symbol or name'),
  },
  async ({ chainId, search }) => {
    const result = await sdk.tokens({ chain: chainId, search });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
);

// ── quote ─────────────────────────────────────────────────────────────────────

server.tool(
  'metaswaps_quote',
  'Get a cross-chain swap quote. Returns one or more routes ranked by output amount. Pass the returned JSON to metaswaps_swap to execute.',
  {
    srcChain: z.number().describe('Source EVM chain ID (e.g. 8453 for Base)'),
    dstChain: z
      .number()
      .describe('Destination EVM chain ID (e.g. 42161 for Arbitrum)'),
    srcToken: z.string().describe('Source token contract address (0x...)'),
    dstToken: z.string().describe('Destination token contract address (0x...)'),
    amount: z
      .string()
      .describe(
        'Input amount in the token\'s smallest unit, as a decimal string (e.g. "1000000" for 1 USDC with 6 decimals)',
      ),
    sender: z.string().describe('Sender wallet address (0x...)'),
    recipient: z
      .string()
      .optional()
      .describe('Recipient wallet address (0x...). Defaults to sender.'),
    slippageBps: z
      .number()
      .optional()
      .describe('Slippage tolerance in basis points. Default: 50 (0.5%)'),
  },
  async (params) => {
    const quote = await sdk.quote({
      srcChain: params.srcChain,
      dstChain: params.dstChain,
      srcToken: params.srcToken as `0x${string}`,
      dstToken: params.dstToken as `0x${string}`,
      amount: params.amount,
      sender: params.sender as `0x${string}`,
      recipient: (params.recipient ?? params.sender) as `0x${string}`,
      slippageBps: params.slippageBps ?? 50,
    });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(quote, null, 2) },
      ],
    };
  },
);

// ── swap ──────────────────────────────────────────────────────────────────────

server.tool(
  'metaswaps_swap',
  'Execute the best route from a quote. Requires HYP_KEY env var (private key). Blocks until the origin transaction is confirmed and Hyperlane message IDs are available, then returns immediately — use metaswaps_check_delivery to poll for destination confirmation.',
  {
    quoteJson: z
      .string()
      .describe('The full QuoteResponse JSON returned by metaswaps_quote'),
  },
  async ({ quoteJson }) => {
    const privateKey = process.env.HYP_KEY;
    if (!privateKey) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Error: HYP_KEY environment variable is not set.',
          },
        ],
        isError: true,
      };
    }

    const quote: QuoteResponse = JSON.parse(quoteJson);
    if (!quote.routes?.length) {
      return {
        content: [
          { type: 'text' as const, text: 'Error: quote contains no routes.' },
        ],
        isError: true,
      };
    }

    const srcChainId = quote.routes[0].steps[0]?.chain;
    if (!srcChainId) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Error: cannot determine source chain from quote.',
          },
        ],
        isError: true,
      };
    }

    const handle = await sdk.swap(quote, {
      type: 'privateKey',
      key: privateKey,
      chainId: srcChainId,
    });

    // Iterate status until we have message IDs or reach a terminal state.
    for await (const update of handle.watch()) {
      const terminal =
        update.status === SwapStatus.Bridging ||
        update.status === SwapStatus.DestinationConfirmed ||
        update.status === SwapStatus.DestSwapExecuted ||
        update.status === SwapStatus.DestSwapFailed ||
        update.status === SwapStatus.Failed;

      if (terminal) {
        const result = {
          originTxHash: handle.originTxHash,
          status: update.status,
          msgIds: update.msgIds ?? [],
          destinationTxHash: update.destinationTxHash,
          ...(update.error ? { error: update.error } : {}),
        };
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(result, null, 2) },
          ],
          isError: update.status === SwapStatus.Failed,
        };
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            originTxHash: handle.originTxHash,
            status: 'unknown',
          }),
        },
      ],
    };
  },
);

// ── check_delivery ────────────────────────────────────────────────────────────

server.tool(
  'metaswaps_check_delivery',
  'Check whether a Hyperlane message has been delivered on the destination chain. Call this periodically after metaswaps_swap returns msgIds. For bridge→swap routes there are multiple message IDs — all must be delivered for the full swap to complete.',
  {
    msgId: z
      .string()
      .describe('Hyperlane message ID (0x...) from metaswaps_swap'),
  },
  async ({ msgId }) => {
    const result = await checkMessageDelivery(msgId);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  },
);

// ── start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
