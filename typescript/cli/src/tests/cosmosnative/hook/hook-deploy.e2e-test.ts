import { expect } from 'chai';

import { HookType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EHookTestCommands } from '../../commands/hook.js';
import {
  CHAIN_NAME_1,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_1,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../consts.js';

const HOOK_CONFIG_PATH = `${TEMP_PATH}/hook-deploy-cosmos-config.yaml`;
const HOOK_OUTPUT_PATH = `${TEMP_PATH}/hook-deploy-cosmos-output.json`;

describe('hyperlane hook deploy e2e tests (CosmosNative)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_1,
  );
  const hyperlaneHook = new HyperlaneE2EHookTestCommands(
    ProtocolType.CosmosNative,
    CHAIN_NAME_1,
    REGISTRY_PATH,
  );

  before(async () => {
    await hyperlaneCore.deployOrUseExistingCore(HYP_KEY);
  });

  it('should deploy a merkleTree hook and return its address', async () => {
    writeYamlOrJson(HOOK_CONFIG_PATH, {
      type: HookType.MERKLE_TREE,
    });

    const output = await hyperlaneHook.deploy(
      HYP_KEY,
      HOOK_CONFIG_PATH,
      HOOK_OUTPUT_PATH,
    );

    expect(output.exitCode).to.equal(0);
    expect(output.stdout).to.include('Hook deployed successfully');

    const result: { chain: string; type: string; address: string } =
      readYamlOrJson(HOOK_OUTPUT_PATH);
    expect(result.chain).to.equal(CHAIN_NAME_1);
    expect(result.type).to.equal(HookType.MERKLE_TREE);
    expect(result.address).to.be.a('string').and.not.empty;
  });
});
