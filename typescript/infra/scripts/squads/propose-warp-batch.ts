import {
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import yargs from 'yargs';
import { z } from 'zod';

import {
  ChainName,
  MultiProtocolProvider,
  SvmMultiProtocolSignerAdapter,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, rootLogger } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../../src/config/deploy-environment.js';
import { squadsConfigs } from '../../src/config/squads.js';
import { submitProposalToSquads } from '../../src/utils/squads.js';
import { getTurnkeySealevelDeployerSigner } from '../../src/utils/turnkey.js';
import { getEnvironmentConfig } from '../core-utils.js';

const ENVIRONMENT: DeployEnvironment = 'mainnet3';

enum ProposalResultStatus {
  Proposed = 'proposed',
  Skipped = 'skipped',
  Failed = 'failed',
}

// Shape produced by SvmSigner.transactionToPrintableJson in svm-sdk.
// We only consume transaction_base58 (canonical v0 wire bytes) — everything
// else is passed through and validated only as "present and string-shaped"
// where the writer guarantees it.
const PrintableSvmTransactionSchema = z
  .object({
    transaction_base58: z.string(),
  })
  .passthrough();

const ReceiptFileSchema = z.array(PrintableSvmTransactionSchema).min(1);

// Filename pattern produced by AltVMFileSubmitter via `hyperlane warp apply`'s
// default file-submitter naming: `<chain>-file-<timestamp>-receipts.json`.
const RECEIPT_FILENAME_RE = /^([a-z0-9_-]+)-file-\d+-receipts\.json$/i;

type FileResult = {
  file: string;
  chain?: ChainName;
  multisigPda?: string;
  txCount?: number;
  status: ProposalResultStatus;
  reason?: string;
};

type ParsedReceipt = {
  chain: ChainName;
  txs: z.infer<typeof ReceiptFileSchema>;
};

function parseReceiptFile(
  filePath: string,
  mpp: MultiProtocolProvider,
): ParsedReceipt | { error: string } {
  const filename = path.basename(filePath);
  const match = filename.match(RECEIPT_FILENAME_RE);
  if (!match) {
    return {
      error: `Filename does not match <chain>-file-<timestamp>-receipts.json`,
    };
  }
  const chain = match[1];

  let protocol: ProtocolType;
  try {
    protocol = mpp.getProtocol(chain);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Unknown chain ${chain}: ${message}` };
  }

  if (protocol !== ProtocolType.Sealevel) {
    return {
      error: `Chain ${chain} has protocol ${protocol}, not Sealevel; use safes/propose-warp-batch.ts instead`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Failed to read/parse JSON: ${message}` };
  }

  const parsed = ReceiptFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: `Schema validation failed: ${parsed.error.message}` };
  }

  return { chain, txs: parsed.data };
}

/**
 * Decodes a base58-encoded v0 unsigned transaction (produced by
 * `serializeUnsignedTransaction` in svm-sdk) back into legacy
 * `TransactionInstruction[]` consumable by `submitProposalToSquads`.
 *
 * The writer emits v0 transactions (`createTransactionMessage({ version: 0 })`),
 * so we must use `VersionedTransaction.deserialize` and decompile the message.
 * The writer does not use address-lookup tables, so `decompile` is called
 * without ALT args.
 */
function rehydrateInstructions(
  transactionBase58: string,
): TransactionInstruction[] {
  const bytes = bs58.decode(transactionBase58);
  const versioned = VersionedTransaction.deserialize(bytes);
  const message = TransactionMessage.decompile(versioned.message);
  return message.instructions;
}

async function proposeFile({
  parsed,
  mpp,
  signerAdapter,
  dryRun,
}: {
  parsed: ParsedReceipt;
  mpp: MultiProtocolProvider;
  signerAdapter: SvmMultiProtocolSignerAdapter;
  dryRun: boolean;
}): Promise<{ txCount: number }> {
  const { chain, txs } = parsed;

  const multisigPda = squadsConfigs[chain]?.multisigPda;
  assert(multisigPda, `No squads config registered for chain ${chain}`);

  const instructions = txs.flatMap((tx) =>
    rehydrateInstructions(tx.transaction_base58),
  );
  const txCount = instructions.length;

  if (dryRun) {
    rootLogger.info(
      chalk.gray(
        `[dry-run] Would propose ${txCount} instruction(s) across ${txs.length} tx(s) on ${chain} multisig ${multisigPda}`,
      ),
    );
    return { txCount };
  }

  const memo = `Hyperlane warp apply batch (${txs.length} tx, ${txCount} ix) for ${chain}`;

  // submitProposalToSquads logs the createSignature + transactionIndex
  // internally; it doesn't return them, so we can't surface them here.
  await submitProposalToSquads(chain, instructions, mpp, signerAdapter, memo);

  return { txCount };
}

function logResult(result: FileResult): void {
  const base = `${result.file} → chain=${result.chain ?? '?'} multisig=${
    result.multisigPda ?? '?'
  } txs=${result.txCount ?? '?'}`;
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
        `  - ${r.file} chain=${r.chain ?? '?'} multisig=${
          r.multisigPda ?? '?'
        } txs=${r.txCount ?? '?'}${reason}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const argv = await yargs(process.argv.slice(2))
    .option('directory', {
      type: 'string',
      describe:
        'Directory containing <chain>-file-<timestamp>-receipts.json files emitted by AltVMFileSubmitter',
      demandOption: true,
      alias: 'd',
    })
    .option('dry-run', {
      type: 'boolean',
      describe:
        'Deserialize + log what would be proposed; skip on-chain action',
      default: false,
    })
    .option('chain-filter', {
      type: 'string',
      describe:
        'Comma-separated list of chain names to limit which files are proposed',
    })
    .strict().argv;

  // To switch governance contexts (e.g., AW Squads vs the currently-active
  // multisig on solanamainnet/eclipsemainnet), edit
  // typescript/infra/src/config/squads.ts. submitProposalToSquads reads
  // multisigPda directly from that config and there is no override hook.
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

  const envConfig = getEnvironmentConfig(ENVIRONMENT);
  const mpp = await envConfig.getMultiProtocolProvider();

  const files = fs
    .readdirSync(directory)
    .filter((f) => f.endsWith('.json'))
    .sort();

  rootLogger.info(`Found ${files.length} JSON file(s) in ${directory}`);

  rootLogger.info(
    'Initializing Turnkey Sealevel signer from GCP Secret Manager...',
  );
  const turnkeySigner = await getTurnkeySealevelDeployerSigner(ENVIRONMENT);
  rootLogger.info(`Using Turnkey signer ${turnkeySigner.publicKey.toBase58()}`);

  const results: FileResult[] = [];

  for (const file of files) {
    const filePath = path.join(directory, file);
    const parsed = parseReceiptFile(filePath, mpp);

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
        multisigPda: squadsConfigs[parsed.chain]?.multisigPda,
        txCount: parsed.txs.length,
        status: ProposalResultStatus.Skipped,
        reason: `Chain ${parsed.chain} not in --chain-filter`,
      };
      results.push(result);
      logResult(result);
      continue;
    }

    // Each chain needs its own SvmMultiProtocolSignerAdapter (it's chain-scoped).
    const signerAdapter = new SvmMultiProtocolSignerAdapter(
      parsed.chain,
      turnkeySigner,
      mpp,
    );

    try {
      const { txCount } = await proposeFile({
        parsed,
        mpp,
        signerAdapter,
        dryRun,
      });
      const result: FileResult = {
        file,
        chain: parsed.chain,
        multisigPda: squadsConfigs[parsed.chain]?.multisigPda,
        txCount,
        status: ProposalResultStatus.Proposed,
      };
      results.push(result);
      logResult(result);
    } catch (error) {
      const result: FileResult = {
        file,
        chain: parsed.chain,
        multisigPda: squadsConfigs[parsed.chain]?.multisigPda,
        txCount: parsed.txs.length,
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
