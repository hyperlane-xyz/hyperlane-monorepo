import { Connection, PublicKey } from '@solana/web3.js';
import { BigNumber, providers } from 'ethers';
import { pino } from 'pino';

import { HyperlaneCore, MultiProvider } from '@hyperlane-xyz/sdk';

import type { ConfirmedBlockTags } from '../../interfaces/IMonitor.js';
import type { RebalanceAction } from '../../tracking/types.js';
import type { NativeDeployedAddresses } from '../fixtures/routes.js';
import { SVM_CHAIN_NAME, SVM_DOMAIN_ID } from '../fixtures/svm-routes.js';
import { relaySvmToEvmMessages } from './SvmRelayHelper.js';
import type { SealevelLocalChainManager } from './SealevelLocalChainManager.js';
import type { SvmEvmLocalDeploymentManager } from './SvmEvmLocalDeploymentManager.js';
import type { TestRebalancerContext } from './TestRebalancer.js';
import {
  chainFromDomain,
  getRouterBalances,
  relayInProgressInventoryDeposits,
} from './TestHelpers.js';

const relayLogger = pino({ level: 'silent' });

/**
 * Get the balance of an SVM warp route token account in lamports.
 */
export async function getSvmWarpRouteBalance(
  connection: Connection,
  warpTokenAta: string,
): Promise<bigint> {
  const balance = await connection.getBalance(new PublicKey(warpTokenAta));
  return BigInt(balance);
}

/**
 * Get the current confirmed slot on an SVM chain.
 */
export async function getSvmSlot(connection: Connection): Promise<number> {
  return connection.getSlot('confirmed');
}

/**
 * Compute block tags for both EVM and SVM chains.
 * Returns a map of chain names to their confirmed block numbers/slots.
 */
export async function computeMixedBlockTags(
  evmProviders: Map<string, providers.JsonRpcProvider>,
  svmConnection: Connection,
  svmChainName: string,
): Promise<ConfirmedBlockTags> {
  const tags: ConfirmedBlockTags = {};

  // Get EVM block numbers
  for (const [chain, provider] of evmProviders) {
    const hex = await provider.send('eth_blockNumber', []);
    tags[chain] = parseInt(hex, 16);
  }

  // Get SVM slot
  const slot = await svmConnection.getSlot('confirmed');
  tags[svmChainName] = slot;

  return tags;
}

/**
 * Fund an SVM warp route token account to a target lamport balance.
 * Idempotent: reads current balance and only transfers the delta needed.
 */
export async function fundSvmWarpRoute(
  chainManager: SealevelLocalChainManager,
  warpTokenAta: string,
  targetLamports: number,
): Promise<void> {
  const currentBalance = await chainManager
    .getConnection()
    .getBalance(new PublicKey(warpTokenAta));
  const delta = targetLamports - currentBalance;
  if (delta <= 0) return;
  await chainManager.fundWarpRoute(warpTokenAta, delta);
}

/**
 * Attempts to drain the SVM warp route ATA balance to zero.
 *
 * NOTE: This is intentionally a no-op. The ATA is a program-derived address (PDA)
 * and has no private key, so `solana transfer --from` cannot sign transactions from it.
 * True draining via the Solana CLI is not possible.
 *
 * Test isolation is instead achieved by `fundSvmWarpRoute` being idempotent:
 * it reads the current balance and only transfers the delta needed to reach the
 * target amount. Tests that set exact SVM balances via `build()` will always
 * reach their target regardless of prior test state, as long as the target
 * is >= the current balance.
 */
export async function drainSvmWarpRoute(
  _manager: SvmEvmLocalDeploymentManager,
  _ataAddress: string,
): Promise<void> {
  // No-op: see JSDoc above for explanation
}

export async function relayMixedInventoryDeposits(
  context: TestRebalancerContext,
  evmProviders: Map<string, providers.JsonRpcProvider>,
  multiProvider: MultiProvider,
  hyperlaneCore: HyperlaneCore,
  svmConnection: Connection,
  svmMailboxProgramId: string | PublicKey,
): Promise<void> {
  const inProgressActions = await context.tracker.getInProgressActions();
  const hasSvmOriginDeposit = inProgressActions.some(
    (action) =>
      action.type === 'inventory_deposit' &&
      action.origin === SVM_DOMAIN_ID &&
      action.txHash &&
      action.messageId,
  );

  const hasEvmOnlyDeposits = inProgressActions.some(
    (action) =>
      action.type === 'inventory_deposit' &&
      action.origin !== SVM_DOMAIN_ID &&
      action.destination !== SVM_DOMAIN_ID &&
      action.txHash &&
      action.messageId,
  );

  if (!hasSvmOriginDeposit && hasEvmOnlyDeposits) {
    await relayInProgressInventoryDeposits(
      context,
      evmProviders,
      multiProvider,
      hyperlaneCore,
    );
  }

  if (hasSvmOriginDeposit) {
    await relaySvmToEvmMessages({
      connection: svmConnection,
      mailboxProgramId:
        typeof svmMailboxProgramId === 'string'
          ? new PublicKey(svmMailboxProgramId)
          : svmMailboxProgramId,
      evmCore: hyperlaneCore,
      multiProvider,
      logger: relayLogger,
    });
  }

  const tags = await computeMixedBlockTags(
    evmProviders,
    svmConnection,
    SVM_CHAIN_NAME,
  );
  await context.tracker.syncRebalanceActions(tags);
}

export async function getMixedRouterBalances(
  evmProviders: Map<string, providers.JsonRpcProvider>,
  evmAddresses: NativeDeployedAddresses,
  svmConnection: Connection,
  svmAtaAddress: string,
): Promise<Record<string, BigNumber>> {
  const evmBalances = await getRouterBalances(evmProviders, evmAddresses);
  const svmBalance = await getSvmWarpRouteBalance(svmConnection, svmAtaAddress);

  return {
    ...evmBalances,
    [SVM_CHAIN_NAME]: BigNumber.from(svmBalance.toString()),
  };
}

function mixedChainFromDomain(domain: number): string {
  if (domain === SVM_DOMAIN_ID) return SVM_CHAIN_NAME;
  return chainFromDomain(domain);
}

export function classifyMixedChains(
  deficitChain: string,
  depositAction: RebalanceAction,
  allChains: readonly string[],
): {
  deficitChain: string;
  surplusChain: string;
  neutralChains: string[];
} {
  const surplusDomain =
    depositAction.type === 'inventory_deposit'
      ? depositAction.destination
      : depositAction.origin;
  const surplusChain = mixedChainFromDomain(surplusDomain);
  const neutralChains = allChains.filter(
    (chain) => chain !== deficitChain && chain !== surplusChain,
  );

  return { deficitChain, surplusChain, neutralChains };
}
