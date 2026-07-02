/**
 * Send test messages through fastpath ISM TestRecipients and print explorer links.
 * Run deploy-fastpath-test-recipients.ts first to create the recipients file.
 *
 * Usage (one origin → all destinations):
 *   yarn tsx scripts/validators/fastpath/test-fastpath-ism.ts \
 *     -e mainnet3 --origin arbitrum --key 0x<key>
 *
 * Usage (one origin → specific destinations):
 *   yarn tsx scripts/validators/fastpath/test-fastpath-ism.ts \
 *     -e mainnet3 --origin arbitrum --chains base ethereum --key 0x<key>
 *
 * Usage (full matrix — all origins → all destinations):
 *   yarn tsx scripts/validators/fastpath/test-fastpath-ism.ts \
 *     -e mainnet3 --key 0x<key>
 *
 * Pass --timeout 0 to skip delivery polling and exit immediately after dispatch.
 */
import { ethers } from 'ethers';

import { DispatchedMessage, HyperlaneCore } from '@hyperlane-xyz/sdk';
import { assert, rootLogger } from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { join } from 'path';

import { Contexts } from '../../../config/contexts.js';
import { getChainAddresses } from '../../../config/registry.js';
import { getEnvironmentDirectory } from '../../../src/paths.js';
import { getInfraPath } from '../../../src/utils/utils.js';
import {
  getAgentConfig,
  getArgs as getBaseArgs,
  withChains,
} from '../../agent-utils.js';
import { getEnvironmentConfig } from '../../core-utils.js';

function getArgs() {
  return withChains(getBaseArgs())
    .option('origin', {
      type: 'string',
      describe:
        'Chain to dispatch messages from (omit for full matrix over all fastpath chains)',
    })
    .option('key', {
      type: 'string',
      describe: 'Deployer private key (pays for dispatch)',
      demandOption: true,
    })
    .option('recipientsFile', {
      alias: 'f',
      type: 'string',
      describe:
        'Path to test-recipients.json (default: environment fastpath/test-recipients.json)',
    })
    .option('timeout', {
      type: 'number',
      default: 120,
      describe: 'Seconds to wait for delivery (0 = dispatch only, no polling)',
    });
}

const POLL_INTERVAL_MS = 1_000;

type MessageResult = {
  origin: string;
  dest: string;
  messageId: string;
  delivered: string;
  latency: string;
};

async function getBlockTimestamp(
  provider: ethers.providers.Provider,
  blockNumber: number,
): Promise<number> {
  const block = await provider.getBlock(blockNumber);
  return block.timestamp;
}

async function main() {
  const { environment, origin, chains, key, recipientsFile, timeout } =
    await getArgs().argv;

  const recipientsFilePath =
    recipientsFile ??
    join(
      getInfraPath(),
      getEnvironmentDirectory(environment),
      'fastpath',
      'test-recipients.json',
    );

  const testRecipients = readJson<Record<string, string>>(recipientsFilePath);

  const agentConfig = getAgentConfig(Contexts.FastPath, environment);
  const fastpathChains = agentConfig.contextChainNames.validator;

  const origins = origin ? [origin] : fastpathChains;
  const destFilter = chains && chains.length > 0 ? chains : fastpathChains;
  const pairs: { from: string; to: string }[] = origins.flatMap((o) =>
    destFilter
      .filter((d: string) => d !== o)
      .map((d: string) => ({ from: o, to: d })),
  );

  for (const { to } of pairs) {
    assert(
      testRecipients[to],
      `No test recipient found for ${to} in ${recipientsFilePath}`,
    );
  }

  const allChains = [...new Set(pairs.flatMap(({ from, to }) => [from, to]))];

  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    undefined,
    false,
    allChains,
  );

  for (const chain of allChains) {
    multiProvider.setSigner(
      chain,
      new ethers.Wallet(key, multiProvider.getProvider(chain)),
    );
  }

  const core = HyperlaneCore.fromAddressesMap(
    getChainAddresses(),
    multiProvider,
  );

  // Track both the display result and the data needed for latency measurement.
  type Pending = {
    result: MessageResult;
    message: DispatchedMessage;
    dispatchBlockNumber: number;
  };

  const pending: Pending[] = [];

  for (const { from, to } of pairs) {
    const body = ethers.utils.hexlify(
      ethers.utils.toUtf8Bytes(`fastpath ISM test ${from}->${to}`),
    );
    rootLogger.info({ from, to }, 'Dispatching test message');
    const { dispatchTx, message } = await core.sendMessage(
      from,
      to,
      testRecipients[to],
      body,
    );
    rootLogger.info(
      { from, to, messageId: message.id, txHash: dispatchTx.transactionHash },
      'Dispatched',
    );
    pending.push({
      result: {
        origin: from,
        dest: to,
        messageId: message.id,
        delivered: timeout > 0 ? '⏳' : '–',
        latency: '–',
      },
      message,
      dispatchBlockNumber: dispatchTx.blockNumber,
    });
  }

  if (timeout > 0) {
    const maxAttempts = Math.ceil((timeout * 1_000) / POLL_INTERVAL_MS);
    rootLogger.info({ timeout, maxAttempts }, 'Polling for delivery...');
    await Promise.all(
      pending.map(async ({ result, message, dispatchBlockNumber }) => {
        try {
          await core.waitForMessageIdProcessed(
            result.messageId,
            result.dest,
            POLL_INTERVAL_MS,
            maxAttempts,
          );
          result.delivered = '✅';

          // Fetch origin and destination block timestamps to compute latency.
          const [originTs, processReceipt] = await Promise.all([
            getBlockTimestamp(
              multiProvider.getProvider(result.origin),
              dispatchBlockNumber,
            ),
            core.getProcessedReceipt(message),
          ]);
          const destTs = await getBlockTimestamp(
            multiProvider.getProvider(result.dest),
            processReceipt.blockNumber,
          );
          const latencySec = destTs - originTs;
          result.latency = `${latencySec}s`;
        } catch {
          result.delivered = '❌ timed out';
        }
      }),
    );
  }

  const results = pending.map((p) => p.result);
  console.table(results);

  const failures = results.filter((r) => r.delivered === '❌ timed out');
  if (failures.length > 0) process.exit(1);
}

main().catch(console.error);
