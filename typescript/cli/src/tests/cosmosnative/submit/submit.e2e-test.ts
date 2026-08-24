import { expect } from 'chai';
import { rmSync, writeFileSync } from 'fs';
import { $ } from 'zx';

import { ChainMetadataSchema, randomAddress } from '@hyperlane-xyz/sdk';
import { randomInt } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { localTestRunCmdPrefix } from '../../commands/helpers.js';
import {
  CHAIN_1_METADATA_PATH,
  CHAIN_NAME_1,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../consts.js';

describe('hyperlane cosmosnative submit e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  it('rejects an external EVM signer before loading its config', async () => {
    const metadata = ChainMetadataSchema.parse(
      readYamlOrJson(CHAIN_1_METADATA_PATH),
    );
    const suffix = randomInt(0, 1_000_000);
    const transactionsPath = `${TEMP_PATH}/cosmos-external-transactions-${suffix}.json`;
    const signerConfigPath = `${TEMP_PATH}/cosmos-external-signer-${suffix}.json`;
    writeYamlOrJson(
      transactionsPath,
      [
        {
          chainId: metadata.domainId,
          data: '0x',
          to: randomAddress(),
        },
      ],
      'json',
    );
    writeFileSync(signerConfigPath, '{}', { mode: 0o600 });

    try {
      const output =
        await $`${localTestRunCmdPrefix()} hyperlane submit --registry ${REGISTRY_PATH} --transactions ${transactionsPath} --signer-config ${signerConfigPath} --yes`.nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.include(
        `External EVM signers cannot submit transactions on ${CHAIN_NAME_1}`,
      );
    } finally {
      rmSync(transactionsPath, { force: true });
      rmSync(signerConfigPath, { force: true });
    }
  });
});
