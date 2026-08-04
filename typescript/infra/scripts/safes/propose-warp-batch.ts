import Safe from '@safe-global/protocol-kit';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import yargs from 'yargs';

import {
  ChainName,
  MultiProvider,
  TurnkeyEvmSigner,
  getSafe,
  getSafeService,
} from '@hyperlane-xyz/sdk';
import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../../src/config/deploy-environment.js';
import { GovernanceType } from '../../src/governanceTypes.js';
import { TurnkeyRole } from '../../src/roles.js';
import {
  createSafeTransaction,
  isLegacySafeApi,
  proposeSafeTransaction,
  retrySafeApi,
} from '../../src/utils/safe.js';
import { createTurnkeySigner } from '../../src/utils/turnkey.js';
import {
  ProposalResultStatus,
  computeExitCode,
  logCounts,
  summarizeResults,
} from '../../src/utils/warp-propose-result.js';
import {
  ParsedReceipt,
  checkSignerOwnsSafe,
  createNonceAllocator,
  decideFileDisposition,
  findMatchingPendingProposal,
  normalizeProposalPayload,
  parseReceiptFile,
  safeQueueKey,
  toMetaTransactionData,
} from '../../src/utils/warp-propose-safe.js';
import { getEnvironmentConfig } from '../core-utils.js';

const ENVIRONMENT: DeployEnvironment = 'mainnet3';

type FileResult = {
  file: string;
  chain?: ChainName;
  safeAddress?: Address;
  txCount?: number;
  safeTxHash?: string;
  governanceType?: GovernanceType;
  status: ProposalResultStatus;
  reason?: string;
};

type ProposeOutcome =
  | { status: typeof ProposalResultStatus.Proposed; safeTxHash: string }
  | { status: typeof ProposalResultStatus.DryRun; safeTxHash: string }
  | { status: typeof ProposalResultStatus.Unsupported; reason: string };

async function proposeFile({
  parsed,
  multiProvider,
  turnkeySigner,
  allocateNonce,
  dryRun,
}: {
  parsed: ParsedReceipt;
  multiProvider: MultiProvider;
  turnkeySigner: TurnkeyEvmSigner;
  allocateNonce: ReturnType<typeof createNonceAllocator>;
  dryRun: boolean;
}): Promise<ProposeOutcome> {
  const { chain, safeAddress, governanceType, receipt } = parsed;

  const safeService = getSafeService(chain, multiProvider);
  const { version } = await retrySafeApi(() => safeService.getServiceInfo());
  const legacy = await isLegacySafeApi(version);
  assert(
    !legacy,
    `Safe Transaction Service for ${chain} is on legacy version ${version}`,
  );

  // Pass the turnkey address as `signer` so Safe.init treats it as the
  // from-address (HexAddress); no private key reaches the SDK. The signing
  // happens via `proposeSafeTransaction` below using the TurnkeyEvmSigner.
  const safeSdk: Safe.default = await retrySafeApi(() =>
    getSafe(chain, multiProvider, safeAddress, turnkeySigner.address),
  );

  const owners = await retrySafeApi(() => safeSdk.getOwners());
  const ownership = checkSignerOwnsSafe(
    owners,
    turnkeySigner.address,
    governanceType,
  );
  if (!ownership.owned) {
    return {
      status: ProposalResultStatus.Unsupported,
      reason: ownership.reason,
    };
  }

  const txData = receipt.transactions.map(toMetaTransactionData);

  // The executed-call payload (to/value/data/operation) is deterministic and
  // independent of nonce, so build once with a placeholder nonce to derive it.
  const probeTransaction = await createSafeTransaction(
    safeSdk,
    txData,
    true,
    0,
  );
  const desiredPayload = normalizeProposalPayload(probeTransaction.data);

  // Idempotent rerun: if this exact payload is already queued — possibly at a
  // different nonce from a prior run — record it and post nothing. This must
  // run BEFORE allocating a nonce; allocating first advances past the pending
  // proposal, yielding a fresh hash that would re-post a duplicate.
  const pending = await retrySafeApi(() =>
    safeService.getPendingTransactions(safeAddress),
  );
  const match = findMatchingPendingProposal(desiredPayload, pending.results);
  if (match) {
    rootLogger.info(
      chalk.gray(
        `Payload already queued on ${chain} safe ${safeAddress} (safeTxHash=${match.safeTxHash}); skipping duplicate POST`,
      ),
    );
    return {
      status: ProposalResultStatus.Proposed,
      safeTxHash: match.safeTxHash,
    };
  }

  const nonce = await allocateNonce({ chain, safeAddress, safeService });
  const safeTransaction = await createSafeTransaction(
    safeSdk,
    txData,
    true,
    nonce,
  );
  const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);

  if (dryRun) {
    rootLogger.info(
      chalk.gray(
        `[dry-run] Would propose ${txData.length} tx(s) on ${chain} safe ${safeAddress} at nonce ${nonce} (safeTxHash=${safeTxHash})`,
      ),
    );
    return { status: ProposalResultStatus.DryRun, safeTxHash };
  }

  await proposeSafeTransaction(
    chain,
    safeSdk,
    safeService,
    safeTransaction,
    safeAddress,
    turnkeySigner,
  );

  return { status: ProposalResultStatus.Proposed, safeTxHash };
}

function logResult(result: FileResult): void {
  const tag = result.governanceType ? ` (${result.governanceType})` : '';
  const base = `${result.file} → chain=${result.chain ?? '?'} safe=${
    result.safeAddress ?? '?'
  }${tag} txs=${result.txCount ?? '?'} hash=${result.safeTxHash ?? '?'}`;
  switch (result.status) {
    case ProposalResultStatus.Proposed:
    case ProposalResultStatus.DryRun:
      rootLogger.info(chalk.green(`[${result.status}] ${base}`));
      return;
    case ProposalResultStatus.Skipped:
      rootLogger.warn(
        chalk.yellow(
          `[${result.status}] ${base} reason=${result.reason ?? ''}`,
        ),
      );
      return;
    case ProposalResultStatus.Invalid:
    case ProposalResultStatus.Unsupported:
    case ProposalResultStatus.Failed:
      rootLogger.error(
        chalk.red(`[${result.status}] ${base} reason=${result.reason ?? ''}`),
      );
      return;
  }
}

async function main(): Promise<void> {
  const argv = await yargs(process.argv.slice(2))
    .option('directory', {
      type: 'string',
      describe:
        'Directory containing combined-chainId<id>-safe<addr>-<ts>-receipts.json files',
      demandOption: true,
      alias: 'd',
    })
    .option('dry-run', {
      type: 'boolean',
      describe: 'Compute safeTxHash and skip the proposal POST',
      default: false,
    })
    .option('chain-filter', {
      type: 'string',
      describe:
        'Comma-separated list of chain names to limit which files are proposed',
    })
    .strict().argv;

  const { directory } = argv;
  const dryRun = argv['dry-run'];
  const chainFilter = argv['chain-filter']
    ? new Set(
        argv['chain-filter']
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
      )
    : undefined;

  assert(fs.existsSync(directory), `Directory ${directory} does not exist`);

  const config = getEnvironmentConfig(ENVIRONMENT);
  const multiProvider = await config.getMultiProvider();

  const files = fs
    .readdirSync(directory)
    .filter((f) => f.endsWith('.json'))
    .sort();

  rootLogger.info(`Found ${files.length} JSON file(s) in ${directory}`);

  const signer = await createTurnkeySigner(
    ENVIRONMENT,
    TurnkeyRole.EvmLegacyDeployer,
  );
  assert(
    signer instanceof TurnkeyEvmSigner,
    `Expected TurnkeyEvmSigner for role ${TurnkeyRole.EvmLegacyDeployer}, got ${signer.constructor.name}`,
  );
  rootLogger.info(`Using Turnkey signer ${signer.address}`);

  const allocateNonce = createNonceAllocator();
  // Safes with a bundle that threw in this run. A failure after nonce
  // allocation (see `createNonceAllocator`) would leave a gap if a later
  // file for the same Safe were proposed on top of it, so every later file
  // for the Safe fails closed here rather than being proposed — see
  // `decideFileDisposition`.
  const poisonedSafes = new Set<string>();
  const results: FileResult[] = [];

  for (const file of files) {
    const filePath = path.join(directory, file);
    const parsed = parseReceiptFile(filePath, multiProvider);
    const disposition = decideFileDisposition({
      parsed,
      chainFilter,
      poisonedSafes,
    });

    if (disposition.action === 'skip' || disposition.action === 'fail') {
      const result: FileResult =
        'error' in parsed
          ? {
              file,
              status: disposition.status,
              reason: disposition.reason,
            }
          : {
              file,
              chain: parsed.chain,
              safeAddress: parsed.safeAddress,
              governanceType: parsed.governanceType,
              txCount: parsed.receipt.transactions.length,
              status: disposition.status,
              reason: disposition.reason,
            };
      results.push(result);
      logResult(result);
      continue;
    }

    // `disposition.action === 'propose'` only when `parseReceiptFile`
    // succeeded (see `decideFileDisposition`).
    assert(
      !('error' in parsed),
      `Invariant violated: decideFileDisposition returned 'propose' for unparsed file ${file}`,
    );

    const txCount = parsed.receipt.transactions.length;
    try {
      const outcome = await proposeFile({
        parsed,
        multiProvider,
        turnkeySigner: signer,
        allocateNonce,
        dryRun,
      });
      const result: FileResult =
        outcome.status === ProposalResultStatus.Unsupported
          ? {
              file,
              chain: parsed.chain,
              safeAddress: parsed.safeAddress,
              governanceType: parsed.governanceType,
              txCount,
              status: outcome.status,
              reason: outcome.reason,
            }
          : {
              file,
              chain: parsed.chain,
              safeAddress: parsed.safeAddress,
              governanceType: parsed.governanceType,
              txCount,
              status: outcome.status,
              safeTxHash: outcome.safeTxHash,
            };
      results.push(result);
      logResult(result);
    } catch (error) {
      poisonedSafes.add(safeQueueKey(parsed.chain, parsed.safeAddress));
      const result: FileResult = {
        file,
        chain: parsed.chain,
        safeAddress: parsed.safeAddress,
        governanceType: parsed.governanceType,
        txCount,
        status: ProposalResultStatus.Failed,
        reason: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      logResult(result);
    }
  }

  const counts = summarizeResults(results.map((r) => r.status));
  logCounts(counts);
  process.exit(computeExitCode(counts));
}

main().catch((error) => {
  rootLogger.error('An error occurred:', error);
  process.exit(1);
});
