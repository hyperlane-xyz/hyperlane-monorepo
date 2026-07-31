import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import yargs from 'yargs';

import {
  ChainName,
  MultiProtocolProvider,
  SvmMultiProtocolSignerAdapter,
} from '@hyperlane-xyz/sdk';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../../src/config/deploy-environment.js';
import { getSquadsKeys, squadsConfigs } from '../../src/config/squads.js';
import { submitReceiptTxsToSquads } from '../../src/utils/squads.js';
import { getTurnkeySealevelDeployerSigner } from '../../src/utils/turnkey.js';
import {
  ProposalResultStatus,
  computeExitCode,
  logCounts,
  summarizeResults,
} from '../../src/utils/warp-propose-result.js';
import {
  ParsedReceipt,
  assertAuthorizedByVault,
  parseReceiptFile,
  planReceiptProposals,
} from '../../src/utils/warp-propose-squads.js';
import { getEnvironmentConfig } from '../core-utils.js';

const ENVIRONMENT: DeployEnvironment = 'mainnet3';

type FileResult = {
  file: string;
  chain?: ChainName;
  multisigPda?: string;
  txCount?: number;
  status: ProposalResultStatus;
  reason?: string;
};

type ProposeOutcome =
  | { status: typeof ProposalResultStatus.Proposed; txCount: number }
  | { status: typeof ProposalResultStatus.DryRun; txCount: number };

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
}): Promise<ProposeOutcome> {
  const { chain, txs } = parsed;

  const { vault, multisigPda } = getSquadsKeys(chain);
  const plans = planReceiptProposals(txs);

  // Fail closed if any instruction authority is not this chain's configured
  // Squads vault: a route governed by a different vault (e.g. an AbacusWorks
  // Squad routed against the regular Squad) is a misrouted receipt, so we throw
  // (recorded as a failure) rather than propose to the wrong multisig — and so
  // a misroute can never be masked by a sibling file's success.
  const authorization = assertAuthorizedByVault(plans, vault.toBase58());
  if (!authorization.ok) {
    throw new Error(authorization.reason);
  }

  const proposalCount = plans.length;

  if (dryRun) {
    rootLogger.info(
      chalk.gray(
        `[dry-run] Would create ${proposalCount} ordered proposal(s) on ${chain} multisig ${multisigPda.toBase58()}`,
      ),
    );
    return { status: ProposalResultStatus.DryRun, txCount: proposalCount };
  }

  const memoBase = `Hyperlane warp apply batch (${proposalCount} tx) for ${chain}`;
  await submitReceiptTxsToSquads(chain, plans, mpp, signerAdapter, memoBase);

  return { status: ProposalResultStatus.Proposed, txCount: proposalCount };
}

function logResult(result: FileResult): void {
  const base = `${result.file} → chain=${result.chain ?? '?'} multisig=${
    result.multisigPda ?? '?'
  } txs=${result.txCount ?? '?'}`;
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
        'Directory containing <chain>-file-<timestamp>-receipts.json files emitted by AltVMFileSubmitter',
      demandOption: true,
      alias: 'd',
    })
    .option('dry-run', {
      type: 'boolean',
      describe:
        'Deserialize + verify vault authority + log what would be proposed; skip on-chain action',
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
  // typescript/infra/src/config/squads.ts. The vault-authority check in
  // proposeFile fails closed if the receipt's authority does not match the
  // configured vault for the chain.
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
      const outcome = await proposeFile({
        parsed,
        mpp,
        signerAdapter,
        dryRun,
      });
      const result: FileResult = {
        file,
        chain: parsed.chain,
        multisigPda: squadsConfigs[parsed.chain]?.multisigPda,
        txCount: outcome.txCount,
        status: outcome.status,
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

  const counts = summarizeResults(results.map((r) => r.status));
  logCounts(counts);
  process.exit(computeExitCode(counts));
}

main().catch((error) => {
  rootLogger.error('An error occurred:', error);
  process.exit(1);
});
