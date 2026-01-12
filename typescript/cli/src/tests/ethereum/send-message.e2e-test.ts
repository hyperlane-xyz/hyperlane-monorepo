import { expect } from 'chai';
import { $ } from 'zx';

import { hyperlaneCoreDeploy } from './commands/core.js';
import {
  hyperlaneSendMessage,
  localTestRunCmdPrefix,
} from './commands/helpers.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
} from './consts.js';

const TEST_REGISTRY_PATH = './test-configs/test-registry';
const SEALEVEL_CHAIN = 'sealevel1';

describe('hyperlane send message e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  before(async () => {
    await Promise.all([
      hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH),
      hyperlaneCoreDeploy(CHAIN_NAME_3, CORE_CONFIG_PATH),
    ]);
  });

  describe('EVM chain validation', () => {
    it('should successfully send message between EVM chains', async () => {
      const { exitCode, stdout } = await hyperlaneSendMessage(
        CHAIN_NAME_2,
        CHAIN_NAME_3,
        { quick: true },
      );

      expect(exitCode).to.equal(0);
      expect(stdout).to.include('Message ID:');
      expect(stdout).to.include(`Sent message from ${CHAIN_NAME_2}`);
    });

    it('should fail with clear error when origin chain is non-EVM', async () => {
      const { exitCode, stdout, stderr } =
        await $`${localTestRunCmdPrefix()} hyperlane send message \
        --registry ${TEST_REGISTRY_PATH} \
        --origin ${SEALEVEL_CHAIN} \
        --destination ${CHAIN_NAME_2} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`.nothrow();

      expect(exitCode).to.equal(1);
      const output = stdout + stderr;
      expect(output).to.include('only supports EVM chains');
      expect(output).to.include(SEALEVEL_CHAIN);
      expect(output).to.include('sealevel');
    });

    it('should fail with clear error when destination chain is non-EVM', async () => {
      const { exitCode, stdout, stderr } =
        await $`${localTestRunCmdPrefix()} hyperlane send message \
        --registry ${TEST_REGISTRY_PATH} \
        --origin ${CHAIN_NAME_2} \
        --destination ${SEALEVEL_CHAIN} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`.nothrow();

      expect(exitCode).to.equal(1);
      const output = stdout + stderr;
      expect(output).to.include('only supports EVM chains');
      expect(output).to.include(SEALEVEL_CHAIN);
      expect(output).to.include('sealevel');
    });

    it('should fail with clear error when both origin and destination are non-EVM', async () => {
      const { exitCode, stdout, stderr } =
        await $`${localTestRunCmdPrefix()} hyperlane send message \
        --registry ${TEST_REGISTRY_PATH} \
        --origin ${SEALEVEL_CHAIN} \
        --destination ${SEALEVEL_CHAIN} \
        --key ${ANVIL_KEY} \
        --verbosity debug \
        --yes`.nothrow();

      expect(exitCode).to.equal(1);
      const output = stdout + stderr;
      expect(output).to.include('only supports EVM chains');
    });
  });
});
