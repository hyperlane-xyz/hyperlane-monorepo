import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { $ } from 'zx';

import { assert } from '@hyperlane-xyz/utils';

import { hyperlaneCoreDeploy } from './commands/core.js';
import {
  hyperlaneSendMessage,
  hyperlaneStatus,
  localTestRunCmdPrefix,
} from './commands/helpers.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from './consts.js';

/**
 * Extracts the message ID from the send message output.
 * The output contains a line like "Message ID: 0x..."
 */
function extractMessageId(output: string): string {
  const match = output.match(/Message ID: (0x[a-fA-F0-9]+)/);
  if (!match) {
    throw new Error('Could not extract message ID from output');
  }
  return match[1];
}

/**
 * Extracts the dispatch transaction hash from the send message output.
 * The output contains a line like "Dispatch TX: 0x..."
 */
function extractDispatchTx(output: string): string {
  const match = output.match(/Dispatch TX: (0x[a-fA-F0-9]{64})/);
  assert(match, 'Could not extract dispatch TX from output');
  return match[1];
}

describe('hyperlane status e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  before(async () => {
    await Promise.all([
      hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH),
      hyperlaneCoreDeploy(CHAIN_NAME_3, CORE_CONFIG_PATH),
    ]);
  });

  describe('status command without keys', () => {
    it('should check message status without requiring private keys', async () => {
      // First, send a message to get a message ID (this requires keys)
      // Use quick mode to skip waiting for delivery since we just need the message ID
      const sendResult = await hyperlaneSendMessage(
        CHAIN_NAME_2,
        CHAIN_NAME_3,
        {
          quick: true,
        },
      );
      const messageId = extractMessageId(sendResult.stdout);

      // Now check status WITHOUT providing a key
      // This should succeed with the fix - status doesn't need keys for read-only checks
      // Use quick mode to not wait for delivery
      const { exitCode, stdout } = await hyperlaneStatus({
        origin: CHAIN_NAME_2,
        messageId,
        quick: true,
        // Note: no key provided
      });

      expect(exitCode).to.equal(0);
      expect(stdout).to.include(messageId);
    });

    it('should not prompt for key with non-existent message ID', async () => {
      // Use a non-existent message ID
      const fakeMessageId =
        '0x0000000000000000000000000000000000000000000000000000000000000001';

      // This should not prompt for keys - the key check happens before message lookup
      // Use timeout since status might hang trying to find the message
      const { stdout } = await hyperlaneStatus({
        origin: CHAIN_NAME_2,
        messageId: fakeMessageId,
        quick: true,
      })
        .timeout('5s')
        .nothrow();

      // Should not prompt for private key
      expect(stdout).to.not.include(
        'Please enter the private key',
        'Should not prompt for private key',
      );
    });
  });

  describe('status command with --relay flag', () => {
    it('should require keys when using --relay flag', async () => {
      // First, send a message to get a message ID
      const sendResult = await hyperlaneSendMessage(
        CHAIN_NAME_2,
        CHAIN_NAME_3,
        {
          quick: true,
        },
      );
      const messageId = extractMessageId(sendResult.stdout);

      // Check status WITH --relay flag and WITH key - should succeed
      // Use quick mode to not wait for relay to complete
      const { exitCode } = await hyperlaneStatus({
        origin: CHAIN_NAME_2,
        messageId,
        relay: true,
        key: ANVIL_KEY,
        quick: true,
      });

      expect(exitCode).to.equal(0);
    });

    it('should actually deliver the message when relaying', async () => {
      // Send a message with quick mode so it is NOT auto-delivered
      const sendResult = await hyperlaneSendMessage(
        CHAIN_NAME_2,
        CHAIN_NAME_3,
        { quick: true },
      );
      const messageId = extractMessageId(sendResult.stdout);

      // Relay via status --relay. Exits non-zero if relay fails.
      const { exitCode } = await hyperlaneStatus({
        origin: CHAIN_NAME_2,
        messageId,
        relay: true,
        key: ANVIL_KEY,
      });

      expect(exitCode).to.equal(0);

      // Verify the message is now delivered
      const { stdout } = await hyperlaneStatus({
        origin: CHAIN_NAME_2,
        messageId,
      });
      expect(stdout).to.include('was delivered');
    });

    it('should prompt for key when using --relay without providing key', async () => {
      // Send a message first
      const sendResult = await hyperlaneSendMessage(
        CHAIN_NAME_2,
        CHAIN_NAME_3,
        {
          quick: true,
        },
      );
      const messageId = extractMessageId(sendResult.stdout);

      // Try status with --relay but without key
      // Use timeout and nothrow since it will hang waiting for input
      const statusProcess = $`${localTestRunCmdPrefix()} hyperlane status \
        --registry ${REGISTRY_PATH} \
        --origin ${CHAIN_NAME_2} \
        --id ${messageId} \
        --relay \
        --verbosity debug \
        --yes`.timeout('10s');

      try {
        await statusProcess;
        // Should not reach here - the command should timeout waiting for key input
        expect.fail('Expected command to timeout waiting for key input');
      } catch (error: any) {
        // The process should have been killed due to timeout
        // or exited with error asking for key
        const output = error.stdout || '';
        // Either it prompts for key or times out
        expect(
          output.includes('Please enter the private key') ||
            error.message.includes('timed out'),
          'Expected to prompt for key or timeout',
        ).to.be.true;
      }
    });
  });

  describe('status with unreachable chain in registry', () => {
    let tempDir: string;

    before(() => {
      // Create a temp registry overlay with an unreachable chain.
      // 192.0.2.1 is RFC 5737 TEST-NET-1, guaranteed unreachable.
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unreachable-reg-'));
      const chainDir = path.join(tempDir, 'chains', 'unreachable-chain');
      fs.mkdirSync(chainDir, { recursive: true });
      fs.writeFileSync(
        path.join(chainDir, 'metadata.yaml'),
        [
          '---',
          'chainId: 99999',
          'domainId: 99999',
          'name: unreachable-chain',
          'protocol: ethereum',
          'rpcUrls:',
          '  - http: http://192.0.2.1:1',
          'nativeToken:',
          '  name: Ether',
          '  symbol: ETH',
          '  decimals: 18',
        ].join('\n'),
      );
    });

    after(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should succeed despite unreachable chain in registry', async () => {
      // Send a message to get a dispatch tx hash
      const sendResult = await hyperlaneSendMessage(
        CHAIN_NAME_2,
        CHAIN_NAME_3,
        { quick: true },
      );
      const dispatchTx = extractDispatchTx(sendResult.stdout);

      // Run status with two registries: base + overlay with unreachable chain.
      // Before the fix, the command would crash trying to connect to unreachable-chain.
      const { exitCode } = await $`${localTestRunCmdPrefix()} hyperlane status \
        --registry ${REGISTRY_PATH} \
        --registry ${tempDir} \
        --origin ${CHAIN_NAME_2} \
        --dispatchTx ${dispatchTx} \
        --relay \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`;

      expect(exitCode).to.equal(0);
    });
  });
});
