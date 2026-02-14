import chalk from 'chalk';
import yargs, { Argv } from 'yargs';

import {
  parseSquadMultisig,
  SquadTxStatus,
  getSquadTxStatus,
  parseSquadProposal,
  getSquadProposal,
  getSquadsKeys,
} from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import {
  getSquadsMultiProtocolProvider,
  withRequiredSquadsChain,
  withTransactionIndex,
} from './cli-helpers.js';

function withVerbose<T>(args: Argv<T>) {
  return args
    .describe('verbose', 'Show verbose output including raw API data')
    .boolean('verbose')
    .default('verbose', false)
    .alias('v', 'verbose');
}

function toBase58IfPossible(
  value: unknown,
  label: string,
  chain: string,
  index?: number,
): string | undefined {
  const labelWithIndex =
    typeof index === 'number' ? `${label}[${index}]` : label;

  if (!value || typeof value !== 'object') {
    rootLogger.warn(
      chalk.yellow(
        `Skipping ${labelWithIndex} on ${chain}: expected object with toBase58(), got ${String(value)}`,
      ),
    );
    return undefined;
  }

  const toBase58Candidate = (value as { toBase58?: unknown }).toBase58;
  if (typeof toBase58Candidate !== 'function') {
    rootLogger.warn(
      chalk.yellow(
        `Skipping ${labelWithIndex} on ${chain}: missing toBase58() method`,
      ),
    );
    return undefined;
  }

  try {
    return toBase58Candidate.call(value);
  } catch (error) {
    rootLogger.warn(
      chalk.yellow(
        `Skipping ${labelWithIndex} on ${chain}: failed to stringify key (${String(error)})`,
      ),
    );
    return undefined;
  }
}

function formatSignerList(
  values: readonly unknown[],
  label: string,
  chain: string,
): string[] {
  const signerList: string[] = [];
  values.forEach((value, index) => {
    const formatted = toBase58IfPossible(value, label, chain, index);
    if (formatted) {
      signerList.push(formatted);
    }
  });
  return signerList;
}

function formatMultisigMemberKey(
  member: unknown,
  chain: string,
  index: number,
): string | undefined {
  if (!member || typeof member !== 'object') {
    rootLogger.warn(
      chalk.yellow(
        `Skipping multisig member[${index}] on ${chain}: expected object, got ${String(member)}`,
      ),
    );
    return undefined;
  }

  const memberRecord = member as { key?: unknown };
  const memberKey = memberRecord.key;
  const base58Key = toBase58IfPossible(
    memberKey,
    'multisig.members',
    chain,
    index,
  );
  if (base58Key) {
    return base58Key;
  }

  if (typeof memberKey === 'string') {
    const trimmedKey = memberKey.trim();
    if (trimmedKey.length > 0) {
      return trimmedKey;
    }
  }

  rootLogger.warn(
    chalk.yellow(
      `Skipping multisig member[${index}] on ${chain}: missing usable key value`,
    ),
  );
  return undefined;
}

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { chain, transactionIndex, verbose } = await withTransactionIndex(
    withVerbose(withRequiredSquadsChain(yargs(process.argv.slice(2)))),
  ).argv;

  rootLogger.info(chalk.blue.bold('🔍 Squads Proposal Reader'));
  rootLogger.info(
    chalk.blue(`Reading proposal ${transactionIndex} on chain: ${chain}`),
  );

  try {
    const squadsKeys = getSquadsKeys(chain);

    const mpp = await getSquadsMultiProtocolProvider();

    rootLogger.info(chalk.gray('Fetching proposal data...'));

    const proposalData = await getSquadProposal(chain, mpp, transactionIndex);

    if (!proposalData) {
      rootLogger.error(
        chalk.red.bold(`Proposal ${transactionIndex} not found on ${chain}`),
      );
      process.exit(1);
    }

    const { proposal, multisig, proposalPda } = proposalData;
    const proposalMultisigAddress =
      toBase58IfPossible(proposal.multisig, 'proposal.multisig', chain) ??
      '[unavailable]';
    const createKeyAddress =
      toBase58IfPossible(multisig.createKey, 'multisig.createKey', chain) ??
      '[unavailable]';
    const configAuthorityAddress =
      toBase58IfPossible(
        multisig.configAuthority,
        'multisig.configAuthority',
        chain,
      ) ?? '[unavailable]';
    const rentCollectorAddress = multisig.rentCollector
      ? (toBase58IfPossible(
          multisig.rentCollector,
          'multisig.rentCollector',
          chain,
        ) ?? '[unavailable]')
      : 'null';

    const parsedProposal = parseSquadProposal(proposal);
    const parsedMultisig = parseSquadMultisig(multisig, `${chain} multisig`);
    const approvedVoters = formatSignerList(
      proposal.approved,
      'proposal.approved',
      chain,
    );
    const rejectedVoters = formatSignerList(
      proposal.rejected,
      'proposal.rejected',
      chain,
    );
    const cancelledVoters = formatSignerList(
      proposal.cancelled,
      'proposal.cancelled',
      chain,
    );
    const multisigMembers = Array.isArray(multisig.members)
      ? multisig.members
      : [];
    const formattedMultisigMembers = multisigMembers
      .map((member, index) => formatMultisigMemberKey(member, chain, index))
      .filter((value): value is string => typeof value === 'string');
    if (!Array.isArray(multisig.members)) {
      rootLogger.warn(
        chalk.yellow(
          `Multisig members field is missing or malformed for ${chain}; continuing without member listing.`,
        ),
      );
    }
    const proposalTransactionIndex = parsedProposal.transactionIndex;
    const isIndexMismatch = proposalTransactionIndex !== transactionIndex;
    if (isIndexMismatch) {
      rootLogger.warn(
        chalk.yellow(
          `Requested transaction index ${transactionIndex} but proposal account reports index ${proposalTransactionIndex}. Using on-chain proposal index for status calculations.`,
        ),
      );
    }

    // Display basic proposal information
    rootLogger.info(chalk.green.bold('\n📋 Proposal Information:'));
    rootLogger.info(chalk.white(`  Chain: ${chain}`));
    if (isIndexMismatch) {
      rootLogger.info(
        chalk.white(`  Requested Transaction Index: ${transactionIndex}`),
      );
      rootLogger.info(
        chalk.white(
          `  On-chain Transaction Index: ${proposalTransactionIndex}`,
        ),
      );
    } else {
      rootLogger.info(chalk.white(`  Transaction Index: ${transactionIndex}`));
    }
    rootLogger.info(chalk.white(`  Proposal PDA: ${proposalPda.toBase58()}`));
    rootLogger.info(chalk.white(`  Multisig PDA: ${proposalMultisigAddress}`));

    // Coerce all numeric fields to consistent types for safe comparison
    const {
      threshold,
      staleTransactionIndex,
      currentTransactionIndex,
      timeLock,
    } = parsedMultisig;
    const {
      status,
      approvals,
      rejections,
      cancellations,
      statusTimestampSeconds,
    } = parsedProposal;
    const derivedStatus = getSquadTxStatus(
      status,
      approvals,
      threshold,
      proposalTransactionIndex,
      staleTransactionIndex,
    );

    // Display proposal status
    rootLogger.info(chalk.green.bold('\n📊 Status Information:'));
    rootLogger.info(chalk.white(`  On-chain Status: ${status}`));
    rootLogger.info(chalk.white(`  Derived Status: ${derivedStatus}`));
    if (typeof statusTimestampSeconds === 'number') {
      const date = new Date(statusTimestampSeconds * 1000);
      rootLogger.info(
        chalk.white(
          `  Timestamp: ${date.toISOString()} (${date.toLocaleString()})`,
        ),
      );
    }

    // Display voting information
    rootLogger.info(chalk.green.bold('\n🗳️  Voting Information:'));
    rootLogger.info(chalk.white(`  Approvals: ${approvals}`));
    rootLogger.info(chalk.white(`  Rejections: ${rejections}`));
    rootLogger.info(chalk.white(`  Cancellations: ${cancellations}`));
    rootLogger.info(chalk.white(`  Threshold: ${threshold}`));

    if (derivedStatus === SquadTxStatus.APPROVED) {
      rootLogger.info(
        chalk.green(
          `  Status: Ready to execute (${approvals}/${threshold} approvals)`,
        ),
      );
    } else if (
      derivedStatus === SquadTxStatus.ACTIVE ||
      derivedStatus === SquadTxStatus.ONE_AWAY
    ) {
      rootLogger.info(
        chalk.yellow(`  Status: Pending (${approvals}/${threshold} approvals)`),
      );
    } else if (derivedStatus === SquadTxStatus.STALE) {
      rootLogger.info(chalk.red(`  Status: Stale`));
    } else {
      rootLogger.info(chalk.blue(`  Status: ${status}`));
    }

    // Display approvers
    if (approvedVoters.length > 0) {
      rootLogger.info(chalk.green.bold('\n✅ Approvers:'));
      approvedVoters.forEach((approver, index) => {
        rootLogger.info(chalk.white(`  ${index + 1}. ${approver}`));
      });
    }

    // Display rejectors
    if (rejectedVoters.length > 0) {
      rootLogger.info(chalk.red.bold('\n❌ Rejectors:'));
      rejectedVoters.forEach((rejector, index) => {
        rootLogger.info(chalk.white(`  ${index + 1}. ${rejector}`));
      });
    }

    // Display cancellers
    if (cancelledVoters.length > 0) {
      rootLogger.info(chalk.gray.bold('\n🚫 Cancellers:'));
      cancelledVoters.forEach((canceller, index) => {
        rootLogger.info(chalk.white(`  ${index + 1}. ${canceller}`));
      });
    }

    // Display transaction details
    rootLogger.info(chalk.green.bold('\n💼 Transaction Details:'));
    rootLogger.info(
      chalk.white(`  Transaction Index: ${proposalTransactionIndex}`),
    );
    rootLogger.info(chalk.white(`  Bump: ${Number(proposal.bump)}`));

    // Display vault information
    const { vault } = squadsKeys;
    const vaultBalance = await mpp
      .getSolanaWeb3Provider(chain)
      .getBalance(vault);
    const nativeToken = mpp.getChainMetadata(chain).nativeToken;
    const decimals = nativeToken?.decimals;
    if (typeof decimals !== 'number') {
      rootLogger.error(chalk.red.bold(`No decimals found for ${chain}`));
      process.exit(1);
    }
    const nativeTokenSymbol = nativeToken?.symbol;
    if (!nativeTokenSymbol) {
      rootLogger.error(
        chalk.red.bold(`No native token symbol found for ${chain}`),
      );
      process.exit(1);
    }
    const balanceFormatted = (vaultBalance / 10 ** decimals).toFixed(5);
    rootLogger.info(chalk.green.bold('\n💰 Vault Information:'));
    rootLogger.info(chalk.white(`  Vault Address: ${vault.toBase58()}`));
    rootLogger.info(
      chalk.white(`  Balance: ${balanceFormatted} ${nativeTokenSymbol}`),
    );

    // Display multisig information
    rootLogger.info(chalk.green.bold('\n🏛️  Multisig Information:'));
    rootLogger.info(chalk.white(`  Threshold: ${threshold}`));
    rootLogger.info(
      chalk.white(`  Members: ${formattedMultisigMembers.length}`),
    );
    rootLogger.info(
      chalk.white(`  Current Transaction Index: ${currentTransactionIndex}`),
    );
    rootLogger.info(chalk.white(`  Time Lock: ${timeLock}`));
    rootLogger.info(
      chalk.white(`  Stale Transaction Index: ${staleTransactionIndex}`),
    );
    rootLogger.info(chalk.white(`  Create Key: ${createKeyAddress}`));
    rootLogger.info(
      chalk.white(`  Config Authority: ${configAuthorityAddress}`),
    );

    // Display members
    rootLogger.info(chalk.green.bold('\n👥 Multisig Members:'));
    formattedMultisigMembers.forEach((memberKey, index) => {
      rootLogger.info(chalk.white(`  ${index + 1}. ${memberKey}`));
    });

    // Verbose output with raw data
    if (verbose) {
      rootLogger.info(chalk.green.bold('\n🔍 Raw Proposal Data:'));
      rootLogger.info(chalk.gray(stringifyObject(proposal)));

      rootLogger.info(chalk.green.bold('\n🔍 Raw Multisig Data:'));
      rootLogger.info(
        chalk.gray(
          stringifyObject({
            createKey: multisig.createKey.toBase58(),
            configAuthority: multisig.configAuthority.toBase58(),
            threshold: threshold,
            timeLock: timeLock,
            transactionIndex: currentTransactionIndex,
            staleTransactionIndex: staleTransactionIndex,
            rentCollector: rentCollectorAddress,
            bump: multisig.bump,
            members: formattedMultisigMembers,
          }),
        ),
      );
    }

    rootLogger.info(
      chalk.green.bold('\n✅ Proposal data retrieved successfully!'),
    );
  } catch (error) {
    rootLogger.error(chalk.red.bold('❌ Error reading proposal:'));
    rootLogger.error(chalk.red(error));
    process.exit(1);
  }
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
