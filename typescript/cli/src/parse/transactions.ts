import { BigNumber } from 'ethers';

import {
  AnnotatedEV5Transaction,
  ParsedTransaction,
  SafeTxMetadata,
  decodeMultiSendData,
  formatFunctionFragmentArgs,
  formatOperationType,
  getSafeService,
  getSafeTxStatus,
  parseSafeTx,
} from '@hyperlane-xyz/sdk';

import { CommandContext } from '../context/types.js';
import { logBlue, logGray } from '../logger.js';

/**
 * Parse a Safe transaction from its transaction hash or all pending transactions.
 *
 * @param context - CLI command context
 * @param chain - Chain where the Safe is deployed
 * @param safeAddress - Address of the Safe multisig
 * @param txHash - Optional transaction hash to parse (parses all pending if not specified)
 * @returns Parsed transaction details
 */
export async function parseSafeTransaction(
  context: CommandContext,
  chain: string,
  safeAddress: string,
  txHash?: string,
): Promise<ParsedSafeResult[]> {
  const { multiProvider } = context;

  logGray(`Connecting to Safe service for ${chain}...`);

  // Get the safe service
  let safeService;
  try {
    safeService = getSafeService(chain, multiProvider);
  } catch (error) {
    throw new Error(
      `Failed to connect to Safe service for ${chain}: ${error}`,
    );
  }

  const results: ParsedSafeResult[] = [];

  if (txHash) {
    // Parse a specific transaction
    logGray(`Fetching transaction ${txHash}...`);
    const safeTx = await safeService.getTransaction(txHash);
    if (!safeTx) {
      throw new Error(`Transaction ${txHash} not found`);
    }

    const parsed = await parseSingleSafeTx(chain, safeTx, multiProvider);
    results.push(parsed);
  } else {
    // Parse all pending transactions
    logGray(`Fetching pending transactions for Safe ${safeAddress}...`);
    const pendingTxs = await safeService.getPendingTransactions(safeAddress);

    if (!pendingTxs || pendingTxs.results.length === 0) {
      logBlue('No pending transactions found');
      return results;
    }

    logBlue(`Found ${pendingTxs.results.length} pending transaction(s)`);

    // Get Safe info for threshold
    const safeInfo = await safeService.getSafeInfo(safeAddress);
    const threshold = safeInfo.threshold;

    for (const tx of pendingTxs.results) {
      const confs = tx.confirmations?.length ?? 0;
      const status = getSafeTxStatus(confs, threshold);

      const parsed = await parseSingleSafeTx(chain, tx, multiProvider);
      parsed.metadata = {
        chain,
        nonce: Number(tx.nonce),
        submissionDate: new Date(tx.submissionDate).toISOString(),
        shortTxHash: `${tx.safeTxHash.slice(0, 6)}...${tx.safeTxHash.slice(-4)}`,
        fullTxHash: tx.safeTxHash,
        confirmations: confs,
        threshold,
        status,
        balance: '',
      };

      results.push(parsed);
    }
  }

  return results;
}

interface ParsedSafeResult {
  metadata?: SafeTxMetadata;
  transaction: ParsedTransaction;
}

/**
 * Parse a single Safe transaction.
 */
async function parseSingleSafeTx(
  chain: string,
  safeTx: any,
  multiProvider: any,
): Promise<ParsedSafeResult> {
  const tx: AnnotatedEV5Transaction = {
    to: safeTx.to,
    data: safeTx.data,
    value: BigNumber.from(safeTx.value || 0),
  };

  // Try to decode the transaction
  let decoded: ParsedTransaction;
  try {
    // Check if it's a Safe function call (swapOwner, addOwnerWithThreshold, etc.)
    const parsed = parseSafeTx(tx);
    const args = formatFunctionFragmentArgs(parsed.args, parsed.functionFragment);

    decoded = {
      chain,
      to: safeTx.to,
      type: parsed.name,
      args,
      insight: formatSafeInsight(parsed.name, args),
    };
  } catch {
    // Not a Safe contract call, try to decode as MultiSend
    try {
      const multiSendTxs = decodeMultiSendData(safeTx.data);
      decoded = {
        chain,
        to: safeTx.to,
        type: 'multiSend',
        insight: `MultiSend batch with ${multiSendTxs.length} transaction(s)`,
        transactions: multiSendTxs.map((msTx, idx) => ({
          index: idx,
          to: msTx.to,
          value: msTx.value,
          operation: formatOperationType(msTx.operation),
          data: msTx.data.length > 100 ? `${msTx.data.slice(0, 100)}...` : msTx.data,
        })),
      };
    } catch {
      // Neither Safe nor MultiSend, return raw
      decoded = {
        chain,
        to: safeTx.to,
        type: 'unknown',
        data: safeTx.data?.length > 100 ? `${safeTx.data.slice(0, 100)}...` : safeTx.data,
        value: safeTx.value,
        insight: 'Unknown transaction type',
      };
    }
  }

  return { transaction: decoded };
}

/**
 * Format a human-readable insight for Safe operations.
 */
function formatSafeInsight(name: string, args: Record<string, any>): string {
  switch (name) {
    case 'swapOwner':
      return `Swap owner ${args.oldOwner} with ${args.newOwner}`;
    case 'addOwnerWithThreshold':
      return `Add owner ${args.owner} with threshold ${args._threshold}`;
    case 'removeOwner':
      return `Remove owner ${args.owner} with threshold ${args._threshold}`;
    case 'changeThreshold':
      return `Change threshold to ${args._threshold}`;
    case 'execTransaction':
      return `Execute transaction to ${args.to}`;
    case 'approveHash':
      return `Approve hash ${args.hashToApprove}`;
    default:
      return `${name} call`;
  }
}

/**
 * Parse a Squads proposal from its transaction index or all pending proposals.
 *
 * @param context - CLI command context
 * @param chain - Chain where the Squads multisig is deployed
 * @param multisig - Optional multisig address
 * @param transactionIndex - Optional transaction index to parse
 * @returns Parsed proposal details
 */
export async function parseSquadsTransaction(
  context: CommandContext,
  chain: string,
  multisig?: string,
  transactionIndex?: number,
): Promise<ParsedSquadsResult[]> {
  const { multiProtocolProvider } = context;

  logGray(`Connecting to Squads on ${chain}...`);

  // For now, we'll return a placeholder since Squads parsing requires
  // the @sqds/multisig package and specific chain configuration.
  // The full implementation would require:
  // 1. Getting the Squads config from registry or multisig address
  // 2. Fetching the multisig account from chain
  // 3. Fetching proposal/transaction accounts
  // 4. Decoding the vault transaction instructions

  const results: ParsedSquadsResult[] = [];

  // Check if the chain is a Sealevel (SVM) chain
  try {
    // Verify the chain supports Sealevel/SVM
    multiProtocolProvider.getSolanaWeb3Provider(chain);

    if (!multisig) {
      logBlue('Squads parsing requires a multisig address. Use --multisig <address>');
      return results;
    }

    // Return basic info for now
    logBlue('Squads transaction parsing requires additional configuration.');
    logGray('For detailed parsing, use the infra parse-txs script.');

    results.push({
      chain,
      multisig: multisig || 'unknown',
      message: 'Squads parsing is available but requires multisig configuration. ' +
        'For full parsing capabilities, consider using the infra scripts or ' +
        'providing the complete multisig setup.',
    });
  } catch (error) {
    throw new Error(`Chain ${chain} is not a Sealevel chain or provider not available: ${error}`);
  }

  return results;
}

interface ParsedSquadsResult {
  chain: string;
  multisig: string;
  transactionIndex?: number;
  status?: string;
  approvals?: number;
  threshold?: number;
  instructions?: any[];
  message?: string;
}
