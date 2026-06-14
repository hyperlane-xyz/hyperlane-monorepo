import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import yargs from 'yargs';

import {
  AnnotatedEV5Transaction,
  ChainName,
  EV5GnosisSafeTxBuilder,
  getSafe,
} from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

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
import { updateSafeOwner } from '../../../src/utils/safe.js';
import { writeAndFormatJsonAtPath } from '../../../src/utils/utils.js';
import { withChains, withPropose } from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

// Root directory for Safe Transaction Builder batch files. Each run gets its own
// subfolder, with one file per chain that could not be proposed automatically.
const OUTPUT_ROOT = 'safe-tx-output';

async function main() {
  const {
    propose,
    governanceType = GovernanceType.Regular,
    chains: chainsArg,
  } = await withChains(
    withGovernanceType(withPropose(yargs(process.argv.slice(2)))),
  ).argv;

  const { signers, threshold } = getGovernanceSigners(governanceType);
  const safes = getGovernanceSafes(governanceType);

  // Default to the full set of chains for the governance type when --chains is omitted.
  const chains =
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
  const writtenFiles: string[] = [];

  for (const chain of chains) {
    const safeAddress = safes[chain];
    if (!safeAddress) {
      rootLogger.error(`[${chain}] safe not found`);
      continue;
    }

    // Build a read-only Safe instance via RPC (no tx service or signer required),
    // so we can generate the owner-update calldata even for chains we can't propose to.
    let safeSdk;
    try {
      safeSdk = await getSafe(chain, multiProvider, safeAddress);
    } catch (error) {
      rootLogger.error(`[${chain}] could not load safe: ${error}`);
      continue;
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
      rootLogger.error(`[${chain}] could not build owner update: ${error}`);
      continue;
    }

    if (transactions.length === 0) {
      rootLogger.info(`[${chain}] already up to date, no transactions`);
      continue;
    }

    // Log the human-readable intent of each transaction as a single message (so
    // it isn't interleaved under concurrency); raw calldata is persisted to the
    // batch files below, not logged.
    rootLogger.info(
      `[${chain}] generated ${transactions.length} owner-update transaction(s):\n` +
        transactions.map((tx) => `  - ${tx.description}`).join('\n'),
    );

    let proposed = false;
    if (propose) {
      try {
        const safeMultiSend = await SafeMultiSend.initialize(
          multiProvider,
          chain as ChainName,
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
        proposed = true;
      } catch (error) {
        rootLogger.warn(
          `[${chain}] could not propose, writing batch file instead: ${error}`,
        );
      }
    }

    // Persist a Safe-UI-importable batch for anything not proposed (dry run or
    // propose failure) using the SDK's GNOSIS_TX_BUILDER submitter, so it can be
    // submitted manually via the Safe Transaction Builder app.
    if (!proposed) {
      let builder: EV5GnosisSafeTxBuilder;
      try {
        builder = await EV5GnosisSafeTxBuilder.create(multiProvider, {
          version: '1.0',
          chain: chain as ChainName,
          safeAddress,
        });
      } catch (error) {
        // No usable tx service for this chain, so we can't produce a Safe
        // Transaction Builder (UI-importable) file. Persist the raw owner-update
        // payload instead so it isn't silently dropped and can be submitted
        // manually / via scripting.
        rootLogger.warn(
          `[${chain}] no usable tx service; writing raw payload (NOT Safe-UI-importable): ${error}`,
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
        writtenFiles.push(filepath);
        rootLogger.info(`[${chain}] wrote raw owner-update payload`);
        continue;
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
      writtenFiles.push(filepath);
      rootLogger.info(`[${chain}] wrote Safe Transaction Builder batch`);
    }
  }

  if (writtenFiles.length > 0) {
    rootLogger.info(
      `Wrote ${writtenFiles.length} batch file(s) to ${runDir} for manual submission ` +
        `(*.json are Safe Transaction Builder-importable; *.raw.json are raw calldata for chains without a tx service).`,
    );
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
