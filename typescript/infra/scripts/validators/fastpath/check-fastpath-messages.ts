/**
 * Verify that fastpath test messages were delivered and that each destination
 * TestRecipient is actually using the correct fastpath ISM.
 *
 * Reads message IDs from test-messages.json (output of test-fastpath-ism.ts)
 * and ISM addresses from isms.json. For each destination chain it checks:
 *   1. mailbox.delivered(messageId) — message reached the mailbox
 *   2. testRecipient.interchainSecurityModule() == fastpathIsm — correct ISM used
 *   3. testRecipient.lastCallMessage() — message body was received
 *
 * Usage:
 *   yarn tsx scripts/validators/fastpath/check-fastpath-messages.ts \
 *     -e mainnet3 \
 *     [--messagesFile  config/environments/mainnet3/fastpath/test-messages.json] \
 *     [--recipientsFile config/environments/mainnet3/fastpath/test-recipients.json] \
 *     [--ismsFile      config/environments/mainnet3/fastpath/isms.json] \
 *     [--chains base ethereum ...]
 */
import { TestRecipient__factory } from '@hyperlane-xyz/core';
import { eqAddress } from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { join } from 'path';

import { getChainAddresses } from '../../../config/registry.js';
import { getEnvironmentDirectory } from '../../../src/paths.js';
import { getInfraPath } from '../../../src/utils/utils.js';
import { getArgs as getBaseArgs, withChains } from '../../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../../core-utils.js';

function getArgs() {
  return withChains(getBaseArgs())
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
  lastCallMessage: string;
};

async function main() {
  const { environment, chains, messagesFile, recipientsFile, ismsFile } =
    await getArgs().argv;

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

  // messageIds keys are either "origin->dest" (matrix) or "dest" (single-origin legacy)
  const allKeys = Object.keys(messageIds);
  const isMatrix = allKeys.some((k) => k.includes('->'));

  const pairs: { origin: string; dest: string; messageId: string }[] =
    allKeys.map((key) => {
      if (key.includes('->')) {
        const [origin, dest] = key.split('->');
        return { origin, dest, messageId: messageIds[key] };
      }
      return { origin: '', dest: key, messageId: messageIds[key] };
    });

  const filteredPairs =
    chains && chains.length > 0
      ? pairs.filter((p) => chains.includes(p.dest))
      : pairs;

  const allDests = [...new Set(filteredPairs.map((p) => p.dest))];

  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();
  const { core } = await getHyperlaneCore(environment, multiProvider);

  const rows: Row[] = [];

  for (const { origin, dest, messageId } of filteredPairs) {
    const recipientAddress = testRecipients[dest];
    const expectedIsm = ismAddresses[dest];

    if (!messageId || !recipientAddress || !expectedIsm) {
      rows.push({
        chain: isMatrix ? `${origin}->${dest}` : dest,
        delivered: '❓ missing data',
        ismCorrect: '❓',
        ismOnRecipient: '',
        expectedIsm: expectedIsm ?? '',
        lastCallMessage: '',
      });
      continue;
    }

    const provider = multiProvider.getProvider(dest);
    const mailbox = core.getContracts(dest).mailbox;
    const recipient = TestRecipient__factory.connect(
      recipientAddress,
      provider,
    );

    const [delivered, ismOnRecipient, lastCallMessage] = await Promise.all([
      mailbox.delivered(messageId),
      recipient.interchainSecurityModule(),
      recipient.lastCallMessage().catch(() => ''),
    ]);

    const ismCorrect = eqAddress(ismOnRecipient, expectedIsm);

    rows.push({
      chain: isMatrix ? `${origin}->${dest}` : dest,
      delivered: delivered ? '✅' : '❌',
      ismCorrect: ismCorrect ? '✅' : '❌',
      ismOnRecipient,
      expectedIsm,
      lastCallMessage: lastCallMessage.slice(0, 40) || '(empty)',
    });
  }

  console.table(rows);

  const failures = rows.filter(
    (r) => r.delivered !== '✅' || r.ismCorrect !== '✅',
  );
  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} chain(s) failed:`);
    failures.forEach((r) => {
      const reasons = [];
      if (r.delivered !== '✅') reasons.push('not delivered');
      if (r.ismCorrect !== '✅') reasons.push('wrong ISM');
      console.error(`  ${r.chain}: ${reasons.join(', ')}`);
    });
    process.exit(1);
  } else {
    console.log('\n✅ All messages delivered through the fastpath ISM!');
  }
}

main().catch(console.error);
