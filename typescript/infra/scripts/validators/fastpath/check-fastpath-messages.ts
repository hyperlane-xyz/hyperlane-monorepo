/**
 * Verify that fastpath test messages were delivered and that each destination
 * TestRecipient is actually using the correct fastpath ISM.
 *
 * Reads message IDs from test-messages.json (output of test-fastpath-ism.ts)
 * and ISM addresses from isms.json. For each destination chain it checks:
 *   1. mailbox.delivered(messageId) — message reached the mailbox
 *   2. testRecipient.interchainSecurityModule() == fastpathIsm — correct ISM used
 *   3. the specific process tx's ReceivedMessage log == expected origin/body
 *
 * Body/origin are read from the ProcessId(messageId) transaction's own
 * ReceivedMessage log, not from TestRecipient's lastData/lastSender storage —
 * those are single mutable slots per contract, so with multiple origins
 * dispatching to the same destination (the full matrix case) they only ever
 * reflect the most recently processed message, not the one being checked.
 *
 * The expected origin->dest matrix is derived from the fastpath agent config,
 * not from test-messages.json, so an empty/truncated/malformed messages file
 * fails loudly instead of reporting success on zero pairs checked.
 *
 * Usage:
 *   pnpm tsx scripts/validators/fastpath/check-fastpath-messages.ts \
 *     -e mainnet3 \
 *     [--messagesFile  config/environments/mainnet3/fastpath/test-messages.json] \
 *     [--recipientsFile config/environments/mainnet3/fastpath/test-recipients.json] \
 *     [--ismsFile      config/environments/mainnet3/fastpath/isms.json] \
 *     [--chains base ethereum ...]
 */
import { Mailbox, TestRecipient__factory } from '@hyperlane-xyz/core';
import { assert, eqAddress } from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { join } from 'path';

import { Contexts } from '../../../config/contexts.js';
import { getEnvironmentDirectory } from '../../../src/paths.js';
import { getInfraPath } from '../../../src/utils/utils.js';
import {
  getAgentConfig,
  getArgs as getBaseArgs,
  withChains,
} from '../../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../../core-utils.js';

function getArgs() {
  return withChains(getBaseArgs())
    .option('origin', {
      type: 'string',
      describe:
        'Origin chain the messages were dispatched from (omit for full matrix, matching test-fastpath-ism.ts)',
    })
    .option('messagesFile', {
      type: 'string',
      describe: 'Path to test-messages.json',
    })
    .option('recipientsFile', {
      type: 'string',
      describe: 'Path to test-recipients.json',
    })
    .option('ismsFile', {
      alias: 'f',
      type: 'string',
      describe: 'Path to isms.json',
    });
}

type Row = {
  chain: string;
  delivered: string;
  ismCorrect: string;
  ismOnRecipient: string;
  expectedIsm: string;
  bodyCorrect: string;
};

// Mirrors the body dispatched by test-fastpath-ism.ts for a given pair.
function expectedBody(origin: string, dest: string): string {
  return `fastpath ISM test ${origin}->${dest}`;
}

const testRecipientInterface = TestRecipient__factory.createInterface();

// Reads the ReceivedMessage log emitted by the specific transaction that
// processed `messageId`, rather than TestRecipient's mutable lastData/
// lastSender storage — those are single slots per contract and only ever
// reflect the most recently processed message.
async function getReceivedMessage(
  mailbox: Mailbox,
  messageId: string,
  recipientAddress: string,
): Promise<{ origin: number; message: string } | null> {
  const processedBlock = await mailbox.processedAt(messageId);
  if (processedBlock === 0) return null;
  const events = await mailbox.queryFilter(
    mailbox.filters.ProcessId(messageId),
    processedBlock,
    processedBlock,
  );
  if (events.length !== 1) return null;
  const receipt = await events[0].getTransactionReceipt();
  for (const log of receipt.logs) {
    if (!eqAddress(log.address, recipientAddress)) continue;
    let parsed;
    try {
      parsed = testRecipientInterface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed.name === 'ReceivedMessage') {
      return { origin: parsed.args.origin, message: parsed.args.message };
    }
  }
  return null;
}

async function main() {
  const {
    environment,
    origin,
    chains,
    messagesFile,
    recipientsFile,
    ismsFile,
  } = await getArgs().argv;

  const fastpathDir = join(
    getInfraPath(),
    getEnvironmentDirectory(environment),
    'fastpath',
  );

  const messageIds = readJson<Record<string, string>>(
    messagesFile ?? join(fastpathDir, 'test-messages.json'),
  );
  const testRecipients = readJson<Record<string, string>>(
    recipientsFile ?? join(fastpathDir, 'test-recipients.json'),
  );
  const ismAddresses = readJson<Record<string, string>>(
    ismsFile ?? join(fastpathDir, 'isms.json'),
  );

  // Expected pairs come from the fastpath agent config, independent of
  // whatever test-messages.json happens to contain — an empty, truncated,
  // or malformed messages file must fail the check, not report zero failures.
  const agentConfig = getAgentConfig(Contexts.FastPath, environment);
  const fastpathChains = agentConfig.contextChainNames.validator;
  const origins = origin ? [origin] : fastpathChains;
  const destFilter = chains && chains.length > 0 ? chains : fastpathChains;
  const expectedPairs = origins.flatMap((o) =>
    destFilter
      .filter((dest) => dest !== o)
      .map((dest) => ({ origin: o, dest })),
  );
  assert(
    expectedPairs.length > 0,
    'No expected origin/destination pairs derived from fastpath agent config',
  );

  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();
  const { core } = await getHyperlaneCore(environment, multiProvider);

  const rows: Row[] = [];

  for (const { origin, dest } of expectedPairs) {
    const key = `${origin}->${dest}`;
    const messageId = messageIds[key];
    const recipientAddress = testRecipients[dest];
    const expectedIsm = ismAddresses[dest];

    if (!messageId || !recipientAddress || !expectedIsm) {
      rows.push({
        chain: key,
        delivered: '❓ missing data',
        ismCorrect: '❓',
        ismOnRecipient: '',
        expectedIsm: expectedIsm ?? '',
        bodyCorrect: '❓',
      });
      continue;
    }

    const provider = multiProvider.getProvider(dest);
    const mailbox = core.getContracts(dest).mailbox;
    const recipient = TestRecipient__factory.connect(
      recipientAddress,
      provider,
    );

    const [delivered, ismOnRecipient] = await Promise.all([
      mailbox.delivered(messageId),
      recipient.interchainSecurityModule(),
    ]);

    const ismCorrect = eqAddress(ismOnRecipient, expectedIsm);

    // Bind messageId to this specific pair's origin/recipient/body via the
    // process transaction's own log, not TestRecipient's shared storage slot.
    let bodyCorrect = false;
    if (delivered) {
      const received = await getReceivedMessage(
        mailbox,
        messageId,
        recipientAddress,
      );
      bodyCorrect =
        received !== null &&
        received.message === expectedBody(origin, dest) &&
        received.origin === multiProvider.getDomainId(origin);
    }

    rows.push({
      chain: key,
      delivered: delivered ? '✅' : '❌',
      ismCorrect: ismCorrect ? '✅' : '❌',
      ismOnRecipient,
      expectedIsm,
      bodyCorrect: bodyCorrect ? '✅' : '❌',
    });
  }

  console.table(rows);

  const failures = rows.filter(
    (r) =>
      r.delivered !== '✅' || r.ismCorrect !== '✅' || r.bodyCorrect !== '✅',
  );
  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} pair(s) failed:`);
    failures.forEach((r) => {
      const reasons = [];
      if (r.delivered !== '✅') reasons.push('not delivered');
      if (r.ismCorrect !== '✅') reasons.push('wrong ISM');
      if (r.bodyCorrect !== '✅') reasons.push('unexpected body');
      console.error(`  ${r.chain}: ${reasons.join(', ')}`);
    });
    process.exitCode = 1;
  } else {
    console.log('\n✅ All messages delivered through the fastpath ISM!');
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
