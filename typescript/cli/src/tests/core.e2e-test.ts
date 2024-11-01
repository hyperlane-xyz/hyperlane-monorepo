import { expect } from 'chai';
import { Signer, Wallet } from 'ethers';

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
import { ANVIL_KEY } from './commands/helpers.js';

const CHAIN_NAME = 'anvil2';

const EXAMPLES_PATH = './examples';
const CORE_CONFIG_PATH = `${EXAMPLES_PATH}/core-config.yaml`;

const TEMP_PATH = '/tmp'; // /temp gets removed at the end of all-test.sh
const CORE_READ_CONFIG_PATH = `${TEMP_PATH}/anvil1/core-config-read.yaml`;

const TEST_TIMEOUT = 100_000; // Long timeout since these tests can take a while
describe('hyperlane core e2e tests', async function () {
  this.timeout(TEST_TIMEOUT);

  let initialOwnerAddress: Address;
  before(async () => {
    const signer: Signer = new Wallet(ANVIL_KEY);

    initialOwnerAddress = await signer.getAddress();
  });

  describe('core.deploy', () => {
    it('should create a core deployment with the signer as the mailbox owner', async () => {
      await hyperlaneCoreDeploy(CHAIN_NAME, CORE_CONFIG_PATH);

      const coreConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME,
        CORE_READ_CONFIG_PATH,
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
      writeYamlOrJson(CORE_READ_CONFIG_PATH, coreConfig);

      // Deploy the core contracts with the updated mailbox owner
      await hyperlaneCoreDeploy(CHAIN_NAME, CORE_READ_CONFIG_PATH);

      // Verify that the owner has been set correctly without modifying any other owner values
      const updatedConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME,
        CORE_READ_CONFIG_PATH,
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
      writeYamlOrJson(CORE_READ_CONFIG_PATH, coreConfig);

      // Deploy the core contracts with the updated mailbox owner
      await hyperlaneCoreDeploy(CHAIN_NAME, CORE_READ_CONFIG_PATH);

      // Verify that the owner has been set correctly without modifying any other owner values
      const updatedConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME,
        CORE_READ_CONFIG_PATH,
      );

      expect(updatedConfig.owner).to.equal(initialOwnerAddress);
      expect(updatedConfig.proxyAdmin?.owner.toLowerCase()).to.equal(newOwner);
      // Assuming that the ProtocolFeeHook is used for deployment
      expect(
        (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
      ).to.equal(initialOwnerAddress);
    });
  });

  describe('core.apply', () => {
    it('should update the mailbox owner', async () => {
      await hyperlaneCoreDeploy(CHAIN_NAME, CORE_CONFIG_PATH);
      const coreConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME,
        CORE_READ_CONFIG_PATH,
      );
      expect(coreConfig.owner).to.equal(initialOwnerAddress);
      const newOwner = randomAddress().toLowerCase();
      coreConfig.owner = newOwner;
      writeYamlOrJson(CORE_READ_CONFIG_PATH, coreConfig);
      await hyperlaneCoreApply(CHAIN_NAME, CORE_READ_CONFIG_PATH);
      // Verify that the owner has been set correctly without modifying any other owner values
      const updatedConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME,
        CORE_READ_CONFIG_PATH,
      );
      expect(updatedConfig.owner.toLowerCase()).to.equal(newOwner);
      expect(updatedConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
      // Assuming that the ProtocolFeeHook is used for deployment
      expect(
        (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
      ).to.equal(initialOwnerAddress);
    });

    it('should update the ProxyAdmin owner for the mailbox', async () => {
      await hyperlaneCoreDeploy(CHAIN_NAME, CORE_CONFIG_PATH);
      const coreConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME,
        CORE_READ_CONFIG_PATH,
      );
      expect(coreConfig.owner).to.equal(initialOwnerAddress);
      const newOwner = randomAddress().toLowerCase();
      coreConfig.proxyAdmin!.owner = newOwner;
      writeYamlOrJson(CORE_READ_CONFIG_PATH, coreConfig);
      await hyperlaneCoreApply(CHAIN_NAME, CORE_READ_CONFIG_PATH);
      // Verify that the owner has been set correctly without modifying any other owner values
      const updatedConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME,
        CORE_READ_CONFIG_PATH,
      );
      expect(updatedConfig.owner).to.equal(initialOwnerAddress);
      expect(updatedConfig.proxyAdmin?.owner.toLowerCase()).to.equal(newOwner);
      // Assuming that the ProtocolFeeHook is used for deployment
      expect(
        (updatedConfig.requiredHook as ProtocolFeeHookConfig).owner,
      ).to.equal(initialOwnerAddress);
    });
  });
});
