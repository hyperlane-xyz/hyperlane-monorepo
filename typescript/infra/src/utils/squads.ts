import { PublicKey } from '@solana/web3.js';
import { accounts, getProposalPda } from '@sqds/multisig';
import chalk from 'chalk';

import { ChainName, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

import { getSquadsKeys, squadsConfigs } from '../config/squads.js';

export type SquadProposalStatus = {
  chain: string;
  nonce: number;
  status: string;
  shortTxHash: string;
  fullTxHash: string;
  approvals: number;
  rejections: number;
  cancellations: number;
  threshold: number;
  balance: string;
  submissionDate: string;
};

export enum SquadTxStatus {
  DRAFT = '📝',
  ACTIVE = '🟡',
  APPROVED = '🟢',
  REJECTED = '🔴',
  EXECUTING = '⚡',
  EXECUTED = '✅',
  CANCELLED = '❌',
  STALE = '💩',
}

export async function getSquadAndProvider(
  chain: ChainName,
  mpp: MultiProtocolProvider,
) {
  const svmProvider = mpp.getSolanaWeb3Provider(chain);
  const { multisigPda, programId } = getSquadsKeys(chain);

  return { svmProvider, multisigPda, programId };
}

export async function getSquadProposal(
  chain: ChainName,
  mpp: MultiProtocolProvider,
  transactionIndex: number,
): Promise<
  | {
      proposal: accounts.Proposal;
      multisig: accounts.Multisig;
      proposalPda: PublicKey;
    }
  | undefined
> {
  try {
    const { svmProvider, multisigPda, programId } = await getSquadAndProvider(
      chain,
      mpp,
    );

    // Fetch the deserialized Multisig account
    const multisig = await accounts.Multisig.fromAccountAddress(
      svmProvider as any,
      multisigPda,
    );

    // Get the proposal PDA
    const [proposalPda] = getProposalPda({
      multisigPda,
      transactionIndex: BigInt(transactionIndex),
      programId,
    });

    // Fetch the proposal account
    const proposal = await accounts.Proposal.fromAccountAddress(
      svmProvider as any,
      proposalPda,
    );

    return { proposal, multisig, proposalPda };
  } catch (error) {
    rootLogger.warn(
      chalk.yellow(
        `Failed to fetch proposal ${transactionIndex} on ${chain}: ${error}`,
      ),
    );
    return undefined;
  }
}

export async function getPendingProposalsForChains(
  chains: string[],
  mpp: MultiProtocolProvider,
): Promise<SquadProposalStatus[]> {
  const proposals: SquadProposalStatus[] = [];

  await Promise.all(
    chains.map(async (chain) => {
      if (!squadsConfigs[chain as ChainName]) {
        rootLogger.error(chalk.red.bold(`No squads config found for ${chain}`));
        return;
      }

      try {
        const { svmProvider, multisigPda, programId } =
          await getSquadAndProvider(chain as ChainName, mpp);

        // Fetch the deserialized Multisig account
        const multisig = await accounts.Multisig.fromAccountAddress(
          svmProvider as any,
          multisigPda,
        );

        // Coerce all numeric fields to consistent types for safe comparison
        const threshold = Number(multisig.threshold);
        const currentTransactionIndex = Number(multisig.transactionIndex);
        const staleTransactionIndex = Number(multisig.staleTransactionIndex);

        // Get vault balance using getSquadsKeys for consistent PublicKey construction
        const { vault } = getSquadsKeys(chain as ChainName);
        const vaultBalance = await svmProvider.getBalance(vault);
        const decimals = mpp.getChainMetadata(chain as ChainName).nativeToken
          ?.decimals;
        if (!decimals) {
          rootLogger.error(chalk.red.bold(`No decimals found for ${chain}`));
          return;
        }
        // Convert lamports to SOL
        const balanceFormatted = (vaultBalance / 10 ** decimals).toFixed(5);

        rootLogger.info(
          chalk.gray.italic(
            `Fetching proposals for squads ${multisigPda.toBase58()} on ${chain}`,
          ),
        );

        // Check the last few transaction indices for pending proposals
        const maxIndexToCheck = Math.max(1, currentTransactionIndex - 10);

        for (let i = currentTransactionIndex; i >= maxIndexToCheck; i--) {
          try {
            const proposalData = await getSquadProposal(
              chain as ChainName,
              mpp,
              i,
            );

            if (!proposalData) continue;

            const { proposal, proposalPda } = proposalData;

            // Only include non-executed proposals
            if (proposal.status.__kind === 'Executed') continue;

            // Skip stale transactions
            if (i < staleTransactionIndex) continue;

            const approvals = proposal.approved.length;
            const rejections = proposal.rejected.length;
            const cancellations = proposal.cancelled.length;

            const status = getSquadTxStatus(
              proposal.status.__kind,
              approvals,
              threshold,
              i,
              staleTransactionIndex,
            );

            // Get submission date from status timestamp if available
            let submissionDate = 'Executing';
            if (
              proposal.status.__kind !== 'Executing' &&
              proposal.status.timestamp
            ) {
              const timestamp = Number(proposal.status.timestamp);
              submissionDate = new Date(timestamp * 1000).toDateString();
            }

            proposals.push({
              chain,
              nonce: i,
              status,
              shortTxHash: `${proposalPda.toBase58().slice(0, 6)}...${proposalPda.toBase58().slice(-4)}`,
              fullTxHash: proposalPda.toBase58(),
              approvals,
              rejections,
              cancellations,
              threshold,
              balance: `${balanceFormatted} SOL`,
              submissionDate,
            });
          } catch (error) {
            // Skip if proposal doesn't exist or other error
            continue;
          }
        }
      } catch (error) {
        rootLogger.warn(
          chalk.yellow(
            `Skipping chain ${chain} as there was an error getting the squads data: ${error}`,
          ),
        );
        return;
      }
    }),
  );

  return proposals.sort(
    (a, b) => a.chain.localeCompare(b.chain) || a.nonce - b.nonce,
  );
}

export function getSquadTxStatus(
  statusKind: accounts.Proposal['status']['__kind'],
  approvals: number,
  threshold: number,
  transactionIndex: number,
  staleTransactionIndex: number,
): string {
  // Check if transaction is stale before checking other statuses
  // Only return stale if it hasn't been executed
  if (transactionIndex < staleTransactionIndex && statusKind !== 'Executed') {
    return SquadTxStatus.STALE;
  }

  switch (statusKind) {
    case 'Draft':
      return SquadTxStatus.DRAFT;
    case 'Active':
      return approvals >= threshold
        ? SquadTxStatus.APPROVED
        : SquadTxStatus.ACTIVE;
    case 'Rejected':
      return SquadTxStatus.REJECTED;
    case 'Approved':
      return SquadTxStatus.APPROVED;
    case 'Executing':
      return SquadTxStatus.EXECUTING;
    case 'Executed':
      return SquadTxStatus.EXECUTED;
    case 'Cancelled':
      return SquadTxStatus.CANCELLED;
    default:
      return '❓';
  }
}

export function parseSquadProposal(proposal: accounts.Proposal) {
  // This would parse the proposal data similar to parseSafeTx
  // For now, return basic info
  return {
    status: proposal.status.__kind,
    approvals: proposal.approved.length,
    rejections: proposal.rejected.length,
    cancellations: proposal.cancelled.length,
    transactionIndex: Number(proposal.transactionIndex),
  };
}
