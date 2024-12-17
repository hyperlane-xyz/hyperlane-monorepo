import { expect } from 'chai';
import { Signer, Wallet, ethers } from 'ethers';

import {
  ChainMetadata,
  CoreConfig,
  ProtocolFeeHookConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import { hyperlaneCoreDeploy, readCoreConfig } from './commands/core.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_2,
  DEFAULT_E2E_TEST_TIMEOUT,
} from './commands/helpers.js';

describe('hyperlane core deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let signer: Signer;
  let initialOwnerAddress: Address;

  before(async () => {
    const chainMetadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);

    const provider = new ethers.providers.JsonRpcProvider(
      chainMetadata.rpcUrls[0].http,
    );

    const wallet = new Wallet(ANVIL_KEY);
    signer = wallet.connect(provider);

    initialOwnerAddress = await signer.getAddress();
  });

  it('should create a core deployment with the signer as the mailbox owner', async () => {
    await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);

    const coreConfig: CoreConfig = await readCoreConfig(
      CHAIN_NAME_2,
      CORE_READ_CONFIG_PATH_2,
    );

    expect(coreConfig.owner).to.equal(initialOwnerAddress);
    expect(coreConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
    // Assuming that the ProtocolFeeHook is used for deployment
    expect((coreConfig.requiredHook as ProtocolFeeHookConfig).owner).to.equal(
      initialOwnerAddress,
    );
  });

  it('should create a core deployment with the mailbox owner set to the address in the config', async () => {
    const coreConfig: CoreConfig = await readYamlOrJson(CORE_CONFIG_PATH);

    const newOwner = randomAddress().toLowerCase();

    coreConfig.owner = newOwner;
    writeYamlOrJson(CORE_READ_CONFIG_PATH_2, coreConfig);

    // Deploy the core contracts with the updated mailbox owner
    await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_READ_CONFIG_PATH_2);

    // Verify that the owner has been set correctly without modifying any other owner values
    const updatedConfig: CoreConfig = await readCoreConfig(
      CHAIN_NAME_2,
      CORE_READ_CONFIG_PATH_2,
    );

    expect(updatedConfig.owner.toLowerCase()).to.equal(newOwner);
    expect(updatedConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
    // Assuming that the ProtocolFeeHook is used for deployment
    expect(
      (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
    ).to.equal(initialOwnerAddress);
  });

  it('should create a core deployment with ProxyAdmin owner of the mailbox set to the address in the config', async () => {
    const coreConfig: CoreConfig = await readYamlOrJson(CORE_CONFIG_PATH);

    const newOwner = randomAddress().toLowerCase();

    coreConfig.proxyAdmin = { owner: newOwner };
    writeYamlOrJson(CORE_READ_CONFIG_PATH_2, coreConfig);

    // Deploy the core contracts with the updated mailbox owner
    await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_READ_CONFIG_PATH_2);

    // Verify that the owner has been set correctly without modifying any other owner values
    const updatedConfig: CoreConfig = await readCoreConfig(
      CHAIN_NAME_2,
      CORE_READ_CONFIG_PATH_2,
    );

    expect(updatedConfig.owner).to.equal(initialOwnerAddress);
    expect(updatedConfig.proxyAdmin?.owner.toLowerCase()).to.equal(newOwner);
    // Assuming that the ProtocolFeeHook is used for deployment
    expect(
      (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
    ).to.equal(initialOwnerAddress);
  });
});
