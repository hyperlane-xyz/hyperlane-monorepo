import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  type ChainMetadata,
  type CoreConfig,
  HookType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
} from '../consts.js';

describe('core apply signer discovery', function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);
  let directory: string;

  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'core-apply-signer-'));
  });

  after(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('initializes the signer before deploying a new hook with an existing ICA router', async () => {
    const registryPath = path.join(directory, 'registry');
    const configPath = path.join(directory, 'core.yaml');
    writeYamlOrJson(
      path.join(registryPath, 'chains', CHAIN_NAME_2, 'metadata.yaml'),
      readYamlOrJson<ChainMetadata>(CHAIN_2_METADATA_PATH),
    );
    const commands = new HyperlaneE2ECoreTestCommands(
      ProtocolType.Ethereum,
      CHAIN_NAME_2,
      registryPath,
      CORE_CONFIG_PATH,
      configPath,
    );
    await commands.deploy(ANVIL_KEY);
    const actual = await commands.readConfig();
    assert(
      actual.interchainAccountRouter,
      'Expected core deployment to include an ICA router',
    );
    expect(actual.defaultHook.type).to.equal(HookType.PROTOCOL_FEE);
    const expected: CoreConfig = {
      ...actual,
      defaultHook: { type: HookType.MERKLE_TREE },
    };
    writeYamlOrJson(configPath, expected);

    await commands.apply(ANVIL_KEY);

    const updated = await commands.readConfig();
    expect(updated.defaultHook.type).to.equal(HookType.MERKLE_TREE);
    expect(updated.defaultHook.address).not.to.equal(
      actual.defaultHook.address,
    );
    expect(updated.owner).to.equal(actual.owner);
    expect(updated.defaultIsm.address).to.equal(actual.defaultIsm.address);
    expect(updated.requiredHook.address).to.equal(actual.requiredHook.address);
    expect(updated.interchainAccountRouter?.address).to.equal(
      actual.interchainAccountRouter.address,
    );
    expect(updated.interchainAccountRouter?.owner).to.equal(
      actual.interchainAccountRouter.owner,
    );
  });
});
