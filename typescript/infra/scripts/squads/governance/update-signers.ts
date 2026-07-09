import { PublicKey } from '@solana/web3.js';
import yargs from 'yargs';

import { ChainName, SvmMultiProtocolSignerAdapter } from '@hyperlane-xyz/sdk';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { getGovernanceSvmSigners } from '../../../config/environments/mainnet3/governance/utils.js';
import { squadsConfigs } from '../../../src/config/squads.js';
import { withGovernanceType } from '../../../src/governance.js';
import { GovernanceType } from '../../../src/governanceTypes.js';
import { logTable } from '../../../src/utils/log.js';
import {
  AnnotatedConfigAction,
  submitConfigProposalToSquads,
  updateSquadsMembers,
} from '../../../src/utils/squads.js';
import { getTurnkeySealevelDeployerSigner } from '../../../src/utils/turnkey.js';
import { withChains, withPropose } from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

const environment = 'mainnet3';

// Per-chain outcome, surfaced in the end-of-run summary table.
enum ChainOutcome {
  Proposed = 'proposed', // config transaction created and approved on-chain
  DryRun = 'dry run', // computed actions, nothing submitted (pass --propose to submit)
  NoChange = 'no change', // members already match, nothing to do
  Error = 'error', // could not load squad / build update
}

// Sort order for the summary table so like outcomes group together.
const OUTCOME_ORDER = [
  ChainOutcome.Proposed,
  ChainOutcome.DryRun,
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
            'Confirm applying to all Squads chains when --chains is omitted.',
        }),
      ),
    ),
    Object.keys(squadsConfigs),
  ).argv;

  const { signers, threshold } = getGovernanceSvmSigners(governanceType);
  const members = signers.map((signer) => new PublicKey(signer));

  // Default to the full set of Squads chains when --chains is omitted.
  const allChainsSelected = !chainsArg || chainsArg.length === 0;
  assert(
    !propose || !allChainsSelected || all,
    'Refusing to propose member updates for all Squads without --chains. Pass --all to confirm full-fleet proposal.',
  );

  const chains: ChainName[] = [
    ...new Set(
      chainsArg && chainsArg.length > 0
        ? chainsArg
        : Object.keys(squadsConfigs),
    ),
  ];

  const envConfig = getEnvironmentConfig(environment);
  const mpp = await envConfig.getMultiProtocolProvider();

  // Only initialize the Turnkey signer when actually submitting, so dry runs
  // don't require access to the deployer secret (mirrors squads/get-pending-txs.ts).
  let signerAdapters: Record<string, SvmMultiProtocolSignerAdapter> | undefined;
  if (propose) {
    rootLogger.info('Initializing Turnkey signer...');
    const turnkeySigner = await getTurnkeySealevelDeployerSigner(environment);
    signerAdapters = {};
    for (const chain of chains) {
      signerAdapters[chain] = new SvmMultiProtocolSignerAdapter(
        chain,
        turnkeySigner,
        mpp,
      );
    }
  }

  // Process a single chain end-to-end and return its outcome. Chains are
  // processed concurrently (see Promise.all below); per-chain logging is
  // emitted as single messages so it stays readable when interleaved.
  const processChain = async (chain: ChainName): Promise<ChainResult> => {
    if (!squadsConfigs[chain]) {
      rootLogger.error(`[${chain}] squads config not found`);
      return {
        chain,
        outcome: ChainOutcome.Error,
        detail: 'squads config not found',
      };
    }

    const proposer = signerAdapters?.[chain]?.publicKey();

    let changes: AnnotatedConfigAction[];
    try {
      changes = await updateSquadsMembers({
        chain,
        mpp,
        members,
        threshold,
        proposer,
      });
    } catch (error) {
      rootLogger.error(
        `[${chain}] could not build member update: ${formatError(error)}`,
      );
      return {
        chain,
        outcome: ChainOutcome.Error,
        detail: 'could not build member update',
      };
    }

    if (changes.length === 0) {
      rootLogger.info(`[${chain}] already up to date, no changes`);
      return {
        chain,
        outcome: ChainOutcome.NoChange,
        detail: 'members already match',
      };
    }

    // Log the human-readable intent of each action as a single message (so
    // it isn't interleaved under concurrency).
    rootLogger.info(
      `[${chain}] generated ${changes.length} member-update action(s):\n` +
        changes.map((change) => `  - ${change.description}`).join('\n'),
    );

    if (!signerAdapters) {
      return {
        chain,
        outcome: ChainOutcome.DryRun,
        detail: `${changes.length} action(s), not submitted`,
      };
    }

    try {
      await submitConfigProposalToSquads(
        chain,
        changes.map((change) => change.action),
        mpp,
        signerAdapters[chain],
      );
      return {
        chain,
        outcome: ChainOutcome.Proposed,
        detail: `${changes.length} action(s) proposed`,
      };
    } catch (error) {
      rootLogger.error(`[${chain}] could not propose: ${formatError(error)}`);
      return {
        chain,
        outcome: ChainOutcome.Error,
        detail: 'could not propose',
      };
    }
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

  // End-of-run summary: at a glance, what was proposed vs. what's only been
  // computed (dry run).
  results.sort(
    (a, b) =>
      OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome) ||
      a.chain.localeCompare(b.chain),
  );

  rootLogger.info(
    `\nSummary — ${governanceType} (${results.length} chains). ` +
      `"dry run" = computed but not submitted; pass --propose to submit.`,
  );
  logTable(results, ['chain', 'outcome', 'detail']);

  if (results.some((result) => result.outcome === ChainOutcome.Error)) {
    process.exitCode = 1;
  }
  if (!propose) {
    rootLogger.info('Dry run (no --propose): nothing submitted.');
  }
}

main().catch((error) => {
  rootLogger.error(error);
  process.exit(1);
});
