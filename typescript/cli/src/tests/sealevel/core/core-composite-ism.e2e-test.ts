import { expect } from 'chai';

import {
  type CoreConfig,
  type DerivedCoreConfig,
  IsmType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
} from '../../constants.js';

const CORE_COMPOSITE_ISM_CONFIG_PATH =
  './examples/sealevel/core-config-composite-ism.yaml';

// SVM deploys programs from bytes (~90+ write-chunk transactions per program),
// so the suite needs a generous timeout.
const SVM_DEPLOY_TIMEOUT = 600_000;

describe('hyperlane core deploy/read/check with a compositeIsm defaultIsm (Sealevel E2E tests)', async function () {
  this.timeout(SVM_DEPLOY_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Sealevel,
    'svmlocal1',
    REGISTRY_PATH,
    CORE_COMPOSITE_ISM_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
  );

  before(async function () {
    const coreConfig: CoreConfig = await readYamlOrJson(
      CORE_COMPOSITE_ISM_CONFIG_PATH,
    );

    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      coreConfig,
    );
    hyperlaneCore.setCoreInputPath(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );

    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.sealevel);
  });

  it('should deploy a composite ISM (config-file-only) as the default ISM and read it back', async () => {
    const derivedCoreConfig: DerivedCoreConfig =
      await hyperlaneCore.readConfig();

    expect(derivedCoreConfig.owner).to.equal(
      HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.sealevel,
    );

    const deployedDefaultIsm = derivedCoreConfig.defaultIsm;
    assert(
      deployedDefaultIsm.type === IsmType.COMPOSITE,
      `Expected deployed defaultIsm to be of type ${IsmType.COMPOSITE}`,
    );
    assert(
      deployedDefaultIsm.root.type === 'aggregation',
      'Expected composite ISM root to be an aggregation node',
    );
    expect(deployedDefaultIsm.root.threshold).to.equal(1);
    expect(deployedDefaultIsm.root.subIsms).to.have.length(2);
    expect(
      deployedDefaultIsm.root.subIsms.map((sub) => sub.type).sort(),
    ).to.deep.equal(['test', 'trustedRelayer']);
  });

  it('should report no diff via core check against the deployed compositeIsm', async () => {
    const output = await hyperlaneCore.check(/* mailbox */ undefined).nothrow();
    expect(output.exitCode).to.equal(0);
  });
});
