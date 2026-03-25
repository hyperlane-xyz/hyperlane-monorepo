import { expect } from 'chai';

import { type CoreConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
} from '../../constants.js';

// Uses merkleTreeHook as defaultHook to match what core read returns on SVM,
// avoiding a hook mismatch that would cause apply to redeploy the IGP.
const CORE_APPLY_CONFIG_PATH = './examples/sealevel/core-config-apply.yaml';

// SVM deploys programs from bytes (~90+ write-chunk transactions per program),
// so the suite needs a generous timeout.
const SVM_DEPLOY_TIMEOUT = 600_000;

describe('hyperlane core apply (Sealevel E2E tests)', async function () {
  this.timeout(SVM_DEPLOY_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Sealevel,
    'svmlocal1',
    REGISTRY_PATH,
    CORE_APPLY_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
  );

  // Deploy once before all tests to avoid repeated ~7min deploys
  before(async function () {
    const coreConfig: CoreConfig = await readYamlOrJson(CORE_APPLY_CONFIG_PATH);
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      coreConfig,
    );

    hyperlaneCore.setCoreInputPath(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );

    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.sealevel);
  });

  describe('hyperlane core apply (mailbox updates)', function () {
    it('should update the mailbox owner to the specified one', async () => {
      const coreConfig: CoreConfig = await readYamlOrJson(
        CORE_APPLY_CONFIG_PATH,
      );

      coreConfig.owner = BURN_ADDRESS_BY_PROTOCOL.sealevel;
      writeYamlOrJson(
        CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
        coreConfig,
      );

      await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.sealevel);

      const derivedCoreConfig = await hyperlaneCore.readConfig();
      expect(derivedCoreConfig.owner).to.equal(
        BURN_ADDRESS_BY_PROTOCOL.sealevel,
      );
    });
  });
});
