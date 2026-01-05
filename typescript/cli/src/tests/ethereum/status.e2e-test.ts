import { expect } from 'chai';
import { $ } from 'zx';

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
});
