import { expect } from 'chai';
import { Signer, Wallet, ethers } from 'ethers';

import {
  ChainMetadata,
  CoreConfig,
  HookType,
  ProtocolFeeHookConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  hyperlaneCoreDeploy,
  hyperlaneCoreDeployRaw,
  readCoreConfig,
} from '../commands/core.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  KeyBoardKeys,
  SELECT_MAINNET_CHAIN_TYPE_STEP,
  SETUP_CHAIN_SIGNER_MANUALLY_STEP,
  TestPromptAction,
  handlePrompts,
} from '../commands/helpers.js';

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

  describe('hyperlane core deploy', () => {
    it('should create a core deployment with the signer as the mailbox owner', async () => {
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        {
          check: (currentOutput: string) =>
            currentOutput.includes('--Mainnet Chains--'),
          // Scroll down through the mainnet chains list and select anvil2
          input: `${KeyBoardKeys.ARROW_DOWN.repeat(2)}}${KeyBoardKeys.ENTER}`,
        },
        SETUP_CHAIN_SIGNER_MANUALLY_STEP,
        {
          // When running locally the e2e tests, the chains folder might already have the chain contracts
          check: (currentOutput) =>
            currentOutput.includes('Mailbox already exists at') ||
            currentOutput.includes('Is this deployment plan correct?'),
          input: `yes${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      const output = hyperlaneCoreDeployRaw(CORE_CONFIG_PATH).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const coreConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CONFIG_PATH_2,
      );
      expect(coreConfig.owner).to.equal(initialOwnerAddress);
      expect(coreConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
      // Assuming that the ProtocolFeeHook is used for deployment
      const requiredHookConfig = coreConfig.requiredHook as Exclude<
        CoreConfig['requiredHook'],
        string
      >;
      expect(requiredHookConfig.type).to.equal(HookType.PROTOCOL_FEE);
      expect((requiredHookConfig as ProtocolFeeHookConfig).owner).to.equal(
        initialOwnerAddress,
      );
    });
  });

  describe('hyperlane core deploy --yes', () => {
    it('should fail if the --chain flag is not provided but the --yes flag is', async () => {
      const steps: TestPromptAction[] = [SETUP_CHAIN_SIGNER_MANUALLY_STEP];

      const output = hyperlaneCoreDeployRaw(CORE_CONFIG_PATH, undefined, true)
        .nothrow()
        .stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(1);
      expect(finalOutput.text().includes('No chain provided')).to.be.true;
    });
  });

  describe('hyperlane core deploy --key ...', () => {
    it('should create a core deployment with the signer as the mailbox owner', async () => {
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        {
          check: (currentOutput: string) =>
            currentOutput.includes('--Mainnet Chains--'),
          // Scroll down through the mainnet chains list and select anvil2
          input: `${KeyBoardKeys.ARROW_DOWN.repeat(2)}}${KeyBoardKeys.ENTER}`,
        },
        {
          // When running locally the e2e tests, the chains folder might already have the chain contracts
          check: (currentOutput) =>
            currentOutput.includes('Mailbox already exists at') ||
            currentOutput.includes('Is this deployment plan correct?'),
          input: `yes${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      const output = hyperlaneCoreDeployRaw(CORE_CONFIG_PATH, ANVIL_KEY).stdio(
        'pipe',
      );

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const coreConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CONFIG_PATH_2,
      );
      expect(coreConfig.owner).to.equal(initialOwnerAddress);
      expect(coreConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
      // Assuming that the ProtocolFeeHook is used for deployment
      const requiredHookConfig = coreConfig.requiredHook as Exclude<
        CoreConfig['requiredHook'],
        string
      >;
      expect(requiredHookConfig.type).to.equal(HookType.PROTOCOL_FEE);
      expect((requiredHookConfig as ProtocolFeeHookConfig).owner).to.equal(
        initialOwnerAddress,
      );
    });
  });

  describe('HYP_KEY= ... hyperlane core deploy', () => {
    it('should create a core deployment with the signer as the mailbox owner', async () => {
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        {
          check: (currentOutput: string) =>
            currentOutput.includes('--Mainnet Chains--'),
          // Scroll down through the mainnet chains list and select anvil2
          input: `${KeyBoardKeys.ARROW_DOWN.repeat(2)}}${KeyBoardKeys.ENTER}`,
        },
        {
          // When running locally the e2e tests, the chains folder might already have the chain contracts
          check: (currentOutput) =>
            currentOutput.includes('Mailbox already exists at') ||
            currentOutput.includes('Is this deployment plan correct?'),
          input: `yes${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Is this deployment plan correct?'),
          input: KeyBoardKeys.ENTER,
        },
      ];

      const output = hyperlaneCoreDeployRaw(
        CORE_CONFIG_PATH,
        undefined,
        undefined,
        ANVIL_KEY,
      ).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const coreConfig: CoreConfig = await readCoreConfig(
        CHAIN_NAME_2,
        CORE_READ_CONFIG_PATH_2,
      );
      expect(coreConfig.owner).to.equal(initialOwnerAddress);
      expect(coreConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
      // Assuming that the ProtocolFeeHook is used for deployment
      const requiredHookConfig = coreConfig.requiredHook as Exclude<
        CoreConfig['requiredHook'],
        string
      >;
      expect(requiredHookConfig.type).to.equal(HookType.PROTOCOL_FEE);
      expect((requiredHookConfig as ProtocolFeeHookConfig).owner).to.equal(
        initialOwnerAddress,
      );
    });
  });

  describe('hyperlane core deploy --yes --key ...', () => {
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
});
