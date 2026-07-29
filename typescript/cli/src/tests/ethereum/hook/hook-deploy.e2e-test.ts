import { expect } from 'chai';

import { HookType } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EHookTestCommands } from '../../commands/hook.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../consts.js';

const HOOK_CONFIG_PATH = `${TEMP_PATH}/hook-deploy-evm-config.yaml`;
const HOOK_OUTPUT_PATH = `${TEMP_PATH}/hook-deploy-evm-output.json`;

describe('hyperlane hook deploy e2e tests (EVM)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_2,
  );
  const hyperlaneHook = new HyperlaneE2EHookTestCommands(
    ProtocolType.Ethereum,
    CHAIN_NAME_2,
    REGISTRY_PATH,
  );

  before(async () => {
    await hyperlaneCore.deployOrUseExistingCore(ANVIL_KEY);
  });

  it('should deploy a protocolFee hook and return its address', async () => {
    writeYamlOrJson(HOOK_CONFIG_PATH, {
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee: '1000000000000000000',
      protocolFee: '200000000000000',
      beneficiary: ANVIL_DEPLOYER_ADDRESS,
      owner: ANVIL_DEPLOYER_ADDRESS,
    });

    const output = await hyperlaneHook.deploy(
      ANVIL_KEY,
      HOOK_CONFIG_PATH,
      HOOK_OUTPUT_PATH,
    );

    expect(output.exitCode).to.equal(0);
    expect(output.stdout).to.include('Hook deployed successfully');

    const result: { chain: string; type: string; address: string } =
      readYamlOrJson(HOOK_OUTPUT_PATH);
    expect(result.chain).to.equal(CHAIN_NAME_2);
    expect(result.type).to.equal(HookType.PROTOCOL_FEE);
    expect(result.address).to.match(/^0x[0-9a-fA-F]{40}$/);
    expect(result.address).to.not.equal(
      '0x0000000000000000000000000000000000000000',
    );
  });
});
