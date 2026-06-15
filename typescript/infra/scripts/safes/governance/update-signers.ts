import { mkdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import yargs from 'yargs';

import {
  AnnotatedEV5Transaction,
  ChainName,
  EV5GnosisSafeTxBuilder,
  getSafe,
} from '@hyperlane-xyz/sdk';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { Contexts } from '../../../config/contexts.js';
import {
  getGovernanceSafes,
  getGovernanceSigners,
} from '../../../config/environments/mainnet3/governance/utils.js';
import { SafeMultiSend } from '../../../src/govern/multisend.js';
import { AnnotatedCallData } from '../../../src/govern/types.js';
import { withGovernanceType } from '../../../src/governance.js';
import { GovernanceType } from '../../../src/governanceTypes.js';
import { Role } from '../../../src/roles.js';
import { logTable } from '../../../src/utils/log.js';
import { updateSafeOwner } from '../../../src/utils/safe.js';
import { writeAndFormatJsonAtPath } from '../../../src/utils/utils.js';
import { withChains, withPropose } from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

// Root directory for Safe Transaction Builder batch files. Each run gets its own
// subfolder, with one file per chain that could not be proposed automatically.
const OUTPUT_ROOT = 'safe-tx-output';

// Per-chain outcome, surfaced in the end-of-run summary table.
enum ChainOutcome {
  Proposed = 'proposed', // submitted to the Safe transaction service
  File = 'file', // wrote a Safe-UI-importable Transaction Builder batch
  FileRaw = 'file *', // wrote raw calldata (NOT Safe-UI-importable)
  NoChange = 'no change', // owners already match, nothing to do
  Error = 'error', // could not load safe / build update
}

// Sort order for the summary table so like outcomes group together.
const OUTCOME_ORDER = [
  ChainOutcome.Proposed,
  ChainOutcome.File,
  ChainOutcome.FileRaw,
  ChainOutcome.NoChange,
  ChainOutcome.Error,
];

interface ChainResult {
  chain: string;
  outcome: ChainOutcome;
  detail: string;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const {
    propose,
    governanceType = GovernanceType.Regular,
    chains: chainsArg,
    all,
  } = await withChains(
    withGovernanceType(
      withPropose(
        yargs(process.argv.slice(2)).option('all', {
          type: 'boolean',
          default: false,
          describe:
            'Confirm applying to all governance Safe chains when --chains is omitted.',
        }),
      ),
    ),
  ).argv;

  const { signers, threshold } = getGovernanceSigners(governanceType);
  const safes = getGovernanceSafes(governanceType);

  // Default to the full set of chains for the governance type when --chains is omitted.
  const allChainsSelected = !chainsArg || chainsArg.length === 0;
  assert(
    !propose || !allChainsSelected || all,
    'Refusing to propose owner updates for all governance Safes without --chains. Pass --all to confirm full-fleet proposal.',
  );

  const chains: ChainName[] =
    chainsArg && chainsArg.length > 0 ? chainsArg : Object.keys(safes);

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    chains,
  );

  const runDir = join(
    OUTPUT_ROOT,
    governanceType,
    new Date().toISOString().replace(/[:.]/g, '-'),
  );

  // Process a single chain end-to-end and return its outcome. Chains are
  // processed concurrently (see Promise.all below); per-chain logging is
  // emitted as single messages so it stays readable when interleaved.
  const processChain = async (chain: ChainName): Promise<ChainResult> => {
    const safeAddress = safes[chain];
    if (!safeAddress) {
      rootLogger.error(`[${chain}] safe not found`);
      return {
        chain,
        outcome: ChainOutcome.Error,
        detail: 'safe address not found',
      };
    }

    // Build a read-only Safe instance via RPC (no tx service or signer required),
    // so we can generate the owner-update calldata even for chains we can't propose to.
    let safeSdk;
    try {
      safeSdk = await getSafe(chain, multiProvider, safeAddress, undefined, {
        allowUnresolvedSafeVersion: true,
      });
    } catch (error) {
      rootLogger.error(`[${chain}] could not load safe: ${formatError(error)}`);
      return {
        chain,
        outcome: ChainOutcome.Error,
        detail: 'could not load safe',
      };
    }

    let transactions: AnnotatedCallData[];
    try {
      const signer = multiProvider.tryGetSigner(chain);
      const proposer = signer ? await signer.getAddress() : undefined;
      transactions = await updateSafeOwner({
        safeSdk,
        owners: signers,
        threshold,
        proposer,
      });
    } catch (error) {
      rootLogger.error(
        `[${chain}] could not build owner update: ${formatError(error)}`,
      );
      return {
        chain,
        outcome: ChainOutcome.Error,
        detail: 'could not build owner update',
      };
    }

    if (transactions.length === 0) {
      rootLogger.info(`[${chain}] already up to date, no transactions`);
      return {
        chain,
        outcome: ChainOutcome.NoChange,
        detail: 'owners already match',
      };
    }

    // Log the human-readable intent of each transaction as a single message (so
    // it isn't interleaved under concurrency); raw calldata is persisted to the
    // batch files below, not logged.
    rootLogger.info(
      `[${chain}] generated ${transactions.length} owner-update transaction(s):\n` +
        transactions.map((tx) => `  - ${tx.description}`).join('\n'),
    );

    if (propose) {
      try {
        const safeMultiSend = await SafeMultiSend.initialize(
          multiProvider,
          chain,
          safeAddress,
        );
        await safeMultiSend.sendTransactions(
          transactions.map((call) => ({
            to: call.to,
            data: call.data,
            value: call.value,
          })),
        );
        rootLogger.info(`[${chain}] proposed via Safe transaction service`);
        return {
          chain,
          outcome: ChainOutcome.Proposed,
          detail: `${transactions.length} tx via Safe service`,
        };
      } catch (error) {
        rootLogger.warn(
          `[${chain}] could not propose, writing batch file instead: ${formatError(error)}`,
        );
      }
    }

    // Persist a Safe-UI-importable batch for anything not proposed (dry run or
    // propose failure) using the SDK's GNOSIS_TX_BUILDER submitter, so it can be
    // submitted manually via the Safe Transaction Builder app.
    let builder: EV5GnosisSafeTxBuilder;
    try {
      builder = await EV5GnosisSafeTxBuilder.create(multiProvider, {
        version: '1.0',
        chain,
        safeAddress,
      });
    } catch (error) {
      // No usable tx service for this chain, so we can't produce a Safe
      // Transaction Builder (UI-importable) file. Persist the raw owner-update
      // payload instead so it isn't silently dropped and can be submitted
      // manually / via scripting.
      rootLogger.warn(
        `[${chain}] no usable tx service; writing raw payload (NOT Safe-UI-importable): ${formatError(error)}`,
      );
      const filepath = join(runDir, `${chain}.raw.json`);
      mkdirSync(dirname(filepath), { recursive: true });
      await writeAndFormatJsonAtPath(filepath, {
        chain,
        chainId: multiProvider.getEvmChainId(chain),
        safeAddress,
        note: 'Raw owner-update calldata. NOT a Safe Transaction Builder file (no tx service for this chain); submit manually.',
        transactions: transactions.map((call) => ({
          to: call.to,
          value: (call.value ?? 0).toString(),
          data: call.data,
          description: call.description,
        })),
      });
      rootLogger.info(`[${chain}] wrote raw owner-update payload`);
      return {
        chain,
        outcome: ChainOutcome.FileRaw,
        detail: basename(filepath),
      };
    }

    const chainId = multiProvider.getEvmChainId(chain);
    const ev5Txs: AnnotatedEV5Transaction[] = transactions.map((call) => ({
      to: call.to,
      data: call.data,
      value: call.value,
      chainId,
    }));
    const batch = await builder.submit(...ev5Txs);

    const filepath = join(runDir, `${chain}.json`);
    mkdirSync(dirname(filepath), { recursive: true });
    await writeAndFormatJsonAtPath(filepath, batch);
    rootLogger.info(`[${chain}] wrote Safe Transaction Builder batch`);
    return {
      chain,
      outcome: ChainOutcome.File,
      detail: basename(filepath),
    };
  };

  // Process all chains concurrently; each chain is independent. Use allSettled
  // so an unexpected throw on one chain can't abort the whole run (or lose the
  // summary) — any rejection is surfaced as an error row instead.
  const settled = await Promise.allSettled(chains.map(processChain));
  const results: ChainResult[] = settled.map((result, i) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    rootLogger.error(`[${chains[i]}] unexpected error: ${result.reason}`);
    return {
      chain: chains[i],
      outcome: ChainOutcome.Error,
      detail: 'unexpected error',
    };
  });

  // End-of-run summary: at a glance, what was proposed vs. what needs manual
  // submission (and which of those files are NOT Safe-UI-importable, marked *).
  results.sort(
    (a, b) =>
      OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome) ||
      a.chain.localeCompare(b.chain),
  );
  const fileCount = results.filter(
    (r) =>
      r.outcome === ChainOutcome.File || r.outcome === ChainOutcome.FileRaw,
  ).length;

  rootLogger.info(
    `\nSummary — ${governanceType} (${results.length} chains). ` +
      `"file" = manual submission required; "*" = NOT Safe-UI-importable (raw calldata).`,
  );
  logTable(results, ['chain', 'outcome', 'detail']);

  if (fileCount > 0) {
    rootLogger.info(`Batch files written under ${runDir}`);
  }
  if (results.some((result) => result.outcome === ChainOutcome.Error)) {
    process.exitCode = 1;
  }
  if (!propose) {
    rootLogger.info(
      'Dry run (no --propose): nothing submitted; generated batches written to files.',
    );
  }
}

main().catch((error) => {
  rootLogger.error(error);
  process.exit(1);
});
