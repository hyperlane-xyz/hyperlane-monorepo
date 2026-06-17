import Safe from '@safe-global/protocol-kit';
import { MetaTransactionData } from '@safe-global/safe-core-sdk-types';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import yargs from 'yargs';
import { z } from 'zod';

import {
  ChainName,
  MultiProvider,
  TurnkeyEvmSigner,
  getSafe,
  getSafeService,
} from '@hyperlane-xyz/sdk';
import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

import { getSafesByGovernanceForChain } from '../../config/environments/mainnet3/governance/utils.js';
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
import { getEnvironmentConfig } from '../core-utils.js';

const ENVIRONMENT: DeployEnvironment = 'mainnet3';

enum ProposalResultStatus {
  Proposed = 'proposed',
  Skipped = 'skipped',
  Failed = 'failed',
}

const ReceiptTxSchema = z
  .object({
    to: z.string(),
    value: z.union([z.string(), z.number()]).optional(),
    data: z.string().optional(),
    operation: z.number().optional(),
  })
  .passthrough();

const ReceiptFileSchema = z.object({
  version: z.string(),
  chainId: z.string(),
  meta: z.record(z.unknown()).optional(),
  transactions: z.array(ReceiptTxSchema).min(1),
});

type ReceiptFile = z.infer<typeof ReceiptFileSchema>;

// Filename pattern produced by `hyperlane warp apply`'s `writeCombinedBundles`:
// `combined-chainId<chainId>-safe<addr_first_8>-<timestamp>-receipts.json`
const RECEIPT_FILENAME_RE =
  /^combined-chainId(\d+)-safe([0-9a-fA-F]{8})-\d+-receipts\.json$/;

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

type ParsedReceipt = {
  chain: ChainName;
  safeAddress: Address;
  governanceType: GovernanceType;
  receipt: ReceiptFile;
};

function parseReceiptFile(
  filePath: string,
  multiProvider: MultiProvider,
): ParsedReceipt | { error: string } {
  const filename = path.basename(filePath);
  const match = filename.match(RECEIPT_FILENAME_RE);
  if (!match) {
    return {
      error: `Filename does not match combined-chainId<id>-safe<addr8>-<ts>-receipts.json`,
    };
  }
  const chainIdStr = match[1];
  const safeAddr8 = match[2];

  let chain: ChainName;
  try {
    chain = multiProvider.getChainName(chainIdStr);
  } catch (error) {
    return { error: `Unknown chainId ${chainIdStr}: ${error}` };
  }

  const govMatch = getSafesByGovernanceForChain(chain).find(
    (entry) =>
      entry.safe.toLowerCase().slice(2, 10) === safeAddr8.toLowerCase(),
  );
  if (!govMatch) {
    return {
      error: `No governance safe matches ${chain} / safe${safeAddr8}`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { error: `Failed to read/parse JSON: ${error}` };
  }

  const parsed = ReceiptFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: `Schema validation failed: ${parsed.error.message}` };
  }

  if (parsed.data.chainId !== chainIdStr) {
    return {
      error: `Filename chainId ${chainIdStr} does not match file's chainId ${parsed.data.chainId}`,
    };
  }

  return {
    chain,
    safeAddress: govMatch.safe,
    governanceType: govMatch.governanceType,
    receipt: parsed.data,
  };
}

function toMetaTransactionData(
  tx: z.infer<typeof ReceiptTxSchema>,
): MetaTransactionData {
  return {
    to: tx.to,
    value: tx.value !== undefined ? tx.value.toString() : '0',
    data: tx.data ?? '0x',
    ...(tx.operation !== undefined ? { operation: tx.operation } : {}),
  };
}

async function proposeFile({
  parsed,
  multiProvider,
  turnkeySigner,
  dryRun,
}: {
  parsed: ParsedReceipt;
  multiProvider: MultiProvider;
  turnkeySigner: TurnkeyEvmSigner;
  dryRun: boolean;
}): Promise<{ safeTxHash: string; txCount: number }> {
  const { chain, safeAddress, receipt } = parsed;
  const txCount = receipt.transactions.length;

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

  const txData = receipt.transactions.map(toMetaTransactionData);
  const safeTransaction = await createSafeTransaction(safeSdk, txData, true);
  const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);

  if (dryRun) {
    rootLogger.info(
      chalk.gray(
        `[dry-run] Would propose ${txCount} tx(s) on ${chain} safe ${safeAddress} (safeTxHash=${safeTxHash})`,
      ),
    );
    return { safeTxHash, txCount };
  }

  await proposeSafeTransaction(
    chain,
    safeSdk,
    safeService,
    safeTransaction,
    safeAddress,
    turnkeySigner,
  );

  return { safeTxHash, txCount };
}

function logResult(result: FileResult): void {
  const tag = result.governanceType ? ` (${result.governanceType})` : '';
  const base = `${result.file} → chain=${result.chain ?? '?'} safe=${
    result.safeAddress ?? '?'
  }${tag} txs=${result.txCount ?? '?'} hash=${result.safeTxHash ?? '?'}`;
  switch (result.status) {
    case ProposalResultStatus.Proposed:
      rootLogger.info(chalk.green(`[${result.status}] ${base}`));
      return;
    case ProposalResultStatus.Skipped:
      rootLogger.warn(
        chalk.yellow(
          `[${result.status}] ${base} reason=${result.reason ?? ''}`,
        ),
      );
      return;
    case ProposalResultStatus.Failed:
      rootLogger.error(
        chalk.red(`[${result.status}] ${base} reason=${result.reason ?? ''}`),
      );
      return;
  }
}

function logSummary(results: FileResult[]): void {
  const byStatus = new Map<ProposalResultStatus, FileResult[]>();
  for (const status of Object.values(ProposalResultStatus)) {
    byStatus.set(status, []);
  }
  for (const r of results) {
    byStatus.get(r.status)?.push(r);
  }

  rootLogger.info(chalk.bold('\n=== Summary ==='));
  for (const status of Object.values(ProposalResultStatus)) {
    const bucket = byStatus.get(status) ?? [];
    rootLogger.info(chalk.bold(`${status}: ${bucket.length}`));
    for (const r of bucket) {
      const reason = r.reason ? ` (${r.reason})` : '';
      rootLogger.info(
        `  - ${r.file} chain=${r.chain ?? '?'} safe=${
          r.safeAddress ?? '?'
        } txs=${r.txCount ?? '?'} hash=${r.safeTxHash ?? '?'}${reason}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const argv = await yargs(process.argv.slice(2))
    .option('directory', {
      type: 'string',
      describe:
        'Directory containing combined-chainId<id>-safe<addr8>-<ts>-receipts.json files',
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

  const results: FileResult[] = [];

  for (const file of files) {
    const filePath = path.join(directory, file);
    const parsed = parseReceiptFile(filePath, multiProvider);

    if ('error' in parsed) {
      const result: FileResult = {
        file,
        status: ProposalResultStatus.Skipped,
        reason: parsed.error,
      };
      results.push(result);
      logResult(result);
      continue;
    }

    if (chainFilter && !chainFilter.has(parsed.chain)) {
      const result: FileResult = {
        file,
        chain: parsed.chain,
        safeAddress: parsed.safeAddress,
        governanceType: parsed.governanceType,
        txCount: parsed.receipt.transactions.length,
        status: ProposalResultStatus.Skipped,
        reason: `Chain ${parsed.chain} not in --chain-filter`,
      };
      results.push(result);
      logResult(result);
      continue;
    }

    try {
      const { safeTxHash, txCount } = await proposeFile({
        parsed,
        multiProvider,
        turnkeySigner: signer,
        dryRun,
      });
      const result: FileResult = {
        file,
        chain: parsed.chain,
        safeAddress: parsed.safeAddress,
        governanceType: parsed.governanceType,
        txCount,
        safeTxHash,
        status: ProposalResultStatus.Proposed,
      };
      results.push(result);
      logResult(result);
    } catch (error) {
      const result: FileResult = {
        file,
        chain: parsed.chain,
        safeAddress: parsed.safeAddress,
        governanceType: parsed.governanceType,
        txCount: parsed.receipt.transactions.length,
        status: ProposalResultStatus.Failed,
        reason: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      logResult(result);
    }
  }

  logSummary(results);

  const total = results.length;
  const failed = results.filter(
    (r) => r.status === ProposalResultStatus.Failed,
  ).length;
  if (total > 0 && failed === total) {
    process.exit(1);
  }
}

main().catch((error) => {
  rootLogger.error('An error occurred:', error);
  process.exit(1);
});
