/**
 * End-to-end example: quote USDC on Base → USDT on Arbitrum, then execute.
 *
 * Usage:
 *   HYP_KEY=0x<private-key> npx tsx typescript/metaswaps-sdk/src/examples/quote.ts
 *
 * Optional env vars:
 *   ROUTING_URL   Override the routing engine base URL
 *   BASE_RPC      Override the Base RPC URL (chain 8453)
 *   ARB_RPC       Override the Arbitrum RPC URL (chain 42161)
 *   SENDER        Override sender address (defaults to address derived from HYP_KEY)
 *   RECIPIENT     Override recipient address (defaults to sender)
 */
import { ethers } from 'ethers';
import { MetaswapsSDK, SwapStatus, type QuoteStep } from '../index.js';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDT_ARB = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const BASE_CHAIN_ID = 8453;
const ARB_CHAIN_ID = 42161;
const AMOUNT = 10_000n; // 0.01 USDC (6 decimals)
const CHAIN_LABELS: Record<number, string> = {
  [BASE_CHAIN_ID]: 'Base',
  [ARB_CHAIN_ID]: 'Arbitrum',
};
const TOKEN_LABELS: Record<string, string> = {
  [`${BASE_CHAIN_ID}:${USDC_BASE.toLowerCase()}`]: 'USDC',
  [`${ARB_CHAIN_ID}:${USDT_ARB.toLowerCase()}`]: 'USDT',
  [`${ARB_CHAIN_ID}:0xaf88d065e77cc2239327c5edb3a432268e5831`]: 'USDC',
};

async function main(): Promise<void> {
  const privateKey = process.env.HYP_KEY;
  if (!privateKey) {
    console.error('Error: HYP_KEY environment variable is not set.');
    process.exit(1);
  }

  const chainRpcUrls: Record<number, string> = {};
  if (process.env.BASE_RPC) chainRpcUrls[BASE_CHAIN_ID] = process.env.BASE_RPC;
  if (process.env.ARB_RPC) chainRpcUrls[ARB_CHAIN_ID] = process.env.ARB_RPC;

  const sdk = new MetaswapsSDK({
    routingUrl: process.env.ROUTING_URL,
    chainRpcUrls,
  });

  // Derive sender address from private key unless overridden.
  const wallet = new ethers.Wallet(privateKey);
  const sender = (process.env.SENDER ?? wallet.address) as `0x${string}`;
  const recipient = (process.env.RECIPIENT ?? sender) as `0x${string}`;

  console.log(`Sender:    ${sender}`);
  console.log(`Recipient: ${recipient}`);
  console.log(
    `Amount:    ${Number(AMOUNT) / 1e6} USDC on Base → USDT on Arbitrum\n`,
  );

  // ── 1. Quote ──────────────────────────────────────────────────────────────

  console.log('Fetching quote…');
  const quote = await sdk.quote({
    srcChain: BASE_CHAIN_ID,
    dstChain: ARB_CHAIN_ID,
    srcToken: USDC_BASE,
    dstToken: USDT_ARB,
    amount: String(AMOUNT),
    sender,
    recipient,
    slippageBps: 50,
    usePermit2: false,
  });

  if (quote.routes.length === 0) {
    console.error('No routes found for this pair.');
    process.exit(1);
  }

  const expiresIn = Math.round(quote.expiresAt - Date.now() / 1000);
  console.log(`${quote.routes.length} route(s) — expires in ${expiresIn}s\n`);
  for (const [i, route] of quote.routes.entries()) {
    const output = (Number(BigInt(route.output)) / 1e6).toFixed(6);
    const min = (Number(BigInt(route.outputMin)) / 1e6).toFixed(6);
    const path = describeRoutePath(route.steps);
    console.log(`Route ${i + 1}: ${path}`);
    console.log(`  Output: ${output} USDT  (min ${min})\n`);
  }

  const best = quote.routes[0];

  if (!best.tx) {
    console.error('Best route has no transaction payload — cannot execute.');
    process.exit(1);
  }

  // ── 2. Execute ────────────────────────────────────────────────────────────

  console.log('Submitting swap…');
  const handle = await sdk.swap(quote, {
    type: 'privateKey',
    key: privateKey,
    chainId: BASE_CHAIN_ID,
  });

  console.log(`Origin tx: ${handle.originTxHash}`);

  // ── 3. Track ──────────────────────────────────────────────────────────────

  for await (const update of handle.watch()) {
    const ts = new Date(update.timestamp).toISOString();
    switch (update.status) {
      case SwapStatus.OriginConfirmed:
        console.log(`[${ts}] Origin confirmed`);
        break;
      case SwapStatus.Bridging:
        console.log(
          `[${ts}] Bridging… (msg IDs: ${update.msgIds?.map((m) => `${m.label}:${m.msgId}`).join(', ')})`,
        );
        break;
      case SwapStatus.DestinationConfirmed:
        console.log(
          `[${ts}] Delivered — destination tx: ${update.destinationTxHash}`,
        );
        break;
      case SwapStatus.DestSwapExecuted:
        console.log(
          `[${ts}] Destination swap executed — tx: ${update.destinationTxHash}`,
        );
        break;
      case SwapStatus.DestSwapFailed:
        console.log(
          `[${ts}] Destination swap failed (fallback transfer occurred)`,
        );
        break;
      case SwapStatus.Failed:
        console.error(`[${ts}] Swap failed: ${update.error}`);
        process.exit(1);
    }

    if (
      update.status === SwapStatus.DestinationConfirmed ||
      update.status === SwapStatus.DestSwapExecuted ||
      update.status === SwapStatus.DestSwapFailed
    ) {
      break;
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

function describeRoutePath(steps: QuoteStep[]): string {
  const parts: string[] = [];
  for (const step of steps) {
    if (step.type === 'swap') {
      if (parts.length === 0) {
        parts.push(tokenLabel(step.chain, step.tokenIn));
      }
      parts.push(
        `${tokenLabel(step.chain, step.tokenOut)} on ${chainLabel(step.chain)}`,
      );
      continue;
    }

    if (parts.length === 0) {
      parts.push(
        `${tokenLabel(step.chain, step.asset)} on ${chainLabel(step.chain)}`,
      );
    }
    const bridgeName = step.warpRouteId
      ? `Hyperlane bridge (${step.warpRouteId})`
      : 'Hyperlane bridge';
    parts.push(bridgeName);
    parts.push(
      `${tokenLabel(step.destChain, step.asset)} on ${chainLabel(step.destChain)}`,
    );
  }
  return parts.join(' -> ');
}

function tokenLabel(chainId: number, address: string): string {
  return TOKEN_LABELS[`${chainId}:${address.toLowerCase()}`] ?? address;
}

function chainLabel(chainId: number): string {
  return CHAIN_LABELS[chainId] ?? `chain ${chainId}`;
}
