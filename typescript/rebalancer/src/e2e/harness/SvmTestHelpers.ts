import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
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
 * Fund an SVM warp route token account with lamports.
 */
export async function fundSvmWarpRoute(
  chainManager: SealevelLocalChainManager,
  warpTokenAta: string,
  amountLamports: number,
): Promise<void> {
  await chainManager.fundWarpRoute(warpTokenAta, amountLamports);
}

export async function drainSvmWarpRoute(
  manager: SvmEvmLocalDeploymentManager,
  ataAddress: string,
): Promise<void> {
  const chainManager = manager.getSvmChainManager();
  const connection = chainManager.getConnection();
  const deployer = chainManager.getDeployerKeypair();
  const ataPubkey = new PublicKey(ataAddress);

  const initialBalance = await connection.getBalance(ataPubkey);
  if (initialBalance === 0) return;

  await chainManager.fundWarpRoute(ataAddress, 0);
  const balanceAfterResetAttempt = await connection.getBalance(ataPubkey);
  if (balanceAfterResetAttempt === 0) return;

  const instruction = SystemProgram.transfer({
    fromPubkey: ataPubkey,
    toPubkey: deployer.publicKey,
    lamports: balanceAfterResetAttempt,
  });
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction();
  transaction.feePayer = deployer.publicKey;
  transaction.recentBlockhash = blockhash;
  transaction.add(instruction);

  transaction.sign(deployer);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
  );
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
}

export async function relayMixedInventoryDeposits(
  context: TestRebalancerContext,
  evmProviders: Map<string, providers.JsonRpcProvider>,
  multiProvider: MultiProvider,
  hyperlaneCore: HyperlaneCore,
  svmConnection: Connection,
  svmMailboxProgramId: string | PublicKey,
): Promise<void> {
  await relayInProgressInventoryDeposits(
    context,
    evmProviders,
    multiProvider,
    hyperlaneCore,
  );

  const inProgressActions = await context.tracker.getInProgressActions();
  const hasSvmOriginDeposit = inProgressActions.some(
    (action) =>
      action.type === 'inventory_deposit' &&
      action.origin === SVM_DOMAIN_ID &&
      action.txHash &&
      action.messageId,
  );

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
  const surplusChain = mixedChainFromDomain(depositAction.origin);
  const neutralChains = allChains.filter(
    (chain) => chain !== deficitChain && chain !== surplusChain,
  );

  return { deficitChain, surplusChain, neutralChains };
}
