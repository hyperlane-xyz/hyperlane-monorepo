import { expect } from 'chai';

import {
  type HookConfig,
  type IgpHookConfig as IgpHookModuleConfig,
} from '@hyperlane-xyz/sdk';
import { assert, ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EHookTestCommands } from '../../commands/hook.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../../constants.js';

const SVM_DEPLOY_TIMEOUT = 600_000;
const CHAIN = 'svmlocal1';
const HYP_KEY = HYP_KEY_BY_PROTOCOL.sealevel;

const SIGNER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SIGNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const HOOK_CONFIG_FIXTURE_PATH = './examples/sealevel/igp-hook-config.yaml';
const HOOK_DEPLOY_CONFIG_PATH = `${TEMP_PATH}/${CHAIN}/igp-hook-deploy.yaml`;
const HOOK_DEPLOY_OUT_PATH = `${TEMP_PATH}/${CHAIN}/igp-hook-deployed.json`;
const HOOK_READ_OUT_PATH = `${TEMP_PATH}/${CHAIN}/igp-hook-read.yaml`;
const HOOK_APPLY_CONFIG_PATH = `${TEMP_PATH}/${CHAIN}/igp-hook-apply.yaml`;

describe('hyperlane hook deploy / apply (Sealevel IGP E2E tests)', function () {
  this.timeout(SVM_DEPLOY_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Sealevel,
    CHAIN,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
  );
  const hyperlaneHook = new HyperlaneE2EHookTestCommands(
    ProtocolType.Sealevel,
    CHAIN,
    REGISTRY_PATH,
  );

  before(async function () {
    await hyperlaneCore.deployOrUseExistingCore(HYP_KEY);
  });

  it('round-trips contractVersion through deploy → read', async () => {
    const baseConfig = readYamlOrJson<HookConfig>(HOOK_CONFIG_FIXTURE_PATH);
    writeYamlOrJson(HOOK_DEPLOY_CONFIG_PATH, baseConfig);

    const deployedAddress = await hyperlaneHook.deployAndGetAddress(
      HYP_KEY,
      HOOK_DEPLOY_CONFIG_PATH,
      HOOK_DEPLOY_OUT_PATH,
    );

    const read = await hyperlaneHook.readConfig(
      deployedAddress,
      HOOK_READ_OUT_PATH,
    );

    expect(read.type).to.equal('interchainGasPaymaster');
    expect(read).to.have.property('contractVersion', '1.0.0');
  });

  it('updates the signer set via hook apply', async () => {
    const deployed = readYamlOrJson<{ address: string }>(HOOK_DEPLOY_OUT_PATH);

    const baseConfig = readYamlOrJson<IgpHookModuleConfig>(
      HOOK_CONFIG_FIXTURE_PATH,
    );
    assert(
      baseConfig.type === 'interchainGasPaymaster',
      'fixture must describe an IGP hook',
    );
    const updated: IgpHookModuleConfig = {
      ...baseConfig,
      quoteSigners: [SIGNER_A, SIGNER_B],
    };
    writeYamlOrJson(HOOK_APPLY_CONFIG_PATH, updated);

    await hyperlaneHook.apply(
      HYP_KEY,
      deployed.address,
      HOOK_APPLY_CONFIG_PATH,
    );

    const read = await hyperlaneHook.readConfig(
      deployed.address,
      HOOK_READ_OUT_PATH,
    );

    expect(
      new Set(
        ((read as { quoteSigners?: string[] }).quoteSigners ?? []).map((s) =>
          s.toLowerCase(),
        ),
      ),
    ).to.deep.equal(new Set([SIGNER_A, SIGNER_B]));
  });
});
