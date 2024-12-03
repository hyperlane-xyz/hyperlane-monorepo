import { expect } from 'chai';
import { Signer, Wallet, ethers } from 'ethers';

import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import {
  CoreConfig,
  ProtocolFeeHookConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../utils/files.js';

import {
  hyperlaneCoreApply,
  hyperlaneCoreDeploy,
  readCoreConfig,
} from './commands/core.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from './commands/helpers.js';

describe('hyperlane core apply e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let signer: Signer;
  let initialOwnerAddress: Address;

  before(async () => {
    const chainMetadata: any = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${CHAIN_NAME_2}/metadata.yaml`,
    );

    const provider = new ethers.providers.JsonRpcProvider(
      chainMetadata.rpcUrls[0].http,
    );

    const wallet = new Wallet(ANVIL_KEY);
    signer = wallet.connect(provider);

    initialOwnerAddress = await signer.getAddress();
  });

  it('should update the mailbox owner', async () => {
    await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);
    const coreConfig: CoreConfig = await readCoreConfig(
      CHAIN_NAME_2,
      CORE_READ_CONFIG_PATH_2,
    );
    expect(coreConfig.owner).to.equal(initialOwnerAddress);
    const newOwner = randomAddress().toLowerCase();
    coreConfig.owner = newOwner;
    writeYamlOrJson(CORE_READ_CONFIG_PATH_2, coreConfig);
    await hyperlaneCoreApply(CHAIN_NAME_2, CORE_READ_CONFIG_PATH_2);
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

  it('should update the ProxyAdmin to a new one for the mailbox', async () => {
    await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);
    const coreConfig: CoreConfig = await readCoreConfig(
      CHAIN_NAME_2,
      CORE_READ_CONFIG_PATH_2,
    );
    expect(coreConfig.owner).to.equal(initialOwnerAddress);

    const proxyFactory = new ProxyAdmin__factory().connect(signer);
    const deployTx = await proxyFactory.deploy();
    const newProxyAdmin = await deployTx.deployed();
    coreConfig.proxyAdmin!.address = newProxyAdmin.address;

    writeYamlOrJson(CORE_READ_CONFIG_PATH_2, coreConfig);
    await hyperlaneCoreApply(CHAIN_NAME_2, CORE_READ_CONFIG_PATH_2);

    // Verify that the owner has been set correctly without modifying any other owner values
    const updatedConfig: CoreConfig = await readCoreConfig(
      CHAIN_NAME_2,
      CORE_READ_CONFIG_PATH_2,
    );
    expect(updatedConfig.owner).to.equal(initialOwnerAddress);
    expect(updatedConfig.proxyAdmin?.address).to.equal(newProxyAdmin.address);
    // Assuming that the ProtocolFeeHook is used for deployment
    expect(
      (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
    ).to.equal(initialOwnerAddress);
  });

  it('should update the ProxyAdmin owner for the mailbox', async () => {
    await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);
    const coreConfig: CoreConfig = await readCoreConfig(
      CHAIN_NAME_2,
      CORE_READ_CONFIG_PATH_2,
    );
    expect(coreConfig.owner).to.equal(initialOwnerAddress);

    const newOwner = randomAddress().toLowerCase();
    coreConfig.proxyAdmin!.owner = newOwner;
    writeYamlOrJson(CORE_READ_CONFIG_PATH_2, coreConfig);
    await hyperlaneCoreApply(CHAIN_NAME_2, CORE_READ_CONFIG_PATH_2);

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
