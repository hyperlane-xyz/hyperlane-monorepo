import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice } from '@cosmjs/stargate';
import { expect } from 'chai';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import {
  ChainMetadata,
  CoreConfig,
  HookType,
  IgpConfig,
  randomCosmosAddress,
} from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import {
  hyperlaneCoreDeploy,
  hyperlaneCoreDeployRaw,
  readCoreConfig,
} from '../commands/core.js';
import {
  CHAIN_1_METADATA_PATH,
  CHAIN_NAME_1,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_1,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY,
  KeyBoardKeys,
  REGISTRY_PATH,
  SELECT_MAINNET_CHAIN_TYPE_STEP,
  SETUP_CHAIN_SIGNER_MANUALLY_STEP,
  TestPromptAction,
  handlePrompts,
} from '../commands/helpers.js';

describe('hyperlane cosmosnative core deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let signer: SigningHyperlaneModuleClient;
  let initialOwnerAddress: Address;
  let chainMetadata: ChainMetadata;

  before(async () => {
    chainMetadata = readYamlOrJson(CHAIN_1_METADATA_PATH);

    assert(chainMetadata.gasPrice, 'gasPrice not defined in chain metadata');

    const wallet = await DirectSecp256k1Wallet.fromKey(
      Buffer.from(HYP_KEY, 'hex'),
      'hyp',
    );

    signer = await SigningHyperlaneModuleClient.connectWithSigner(
      chainMetadata.rpcUrls[0].http,
      wallet,
      {
        gasPrice: GasPrice.fromString(
          `${chainMetadata.gasPrice.amount}${chainMetadata.gasPrice.denom}`,
        ),
      },
    );

    initialOwnerAddress = signer.account.address;
  });

  describe('hyperlane cosmosnative core deploy', () => {
    it('should create a core deployment with the signer as the mailbox owner', async () => {
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        {
          check: (currentOutput: string) =>
            currentOutput.includes('--Mainnet Chains--'),
          // Scroll down through the mainnet chains list and select hyp1
          input: `${KeyBoardKeys.ARROW_DOWN.repeat(1)}}${KeyBoardKeys.ENTER}`,
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

      const output = hyperlaneCoreDeployRaw(
        CORE_CONFIG_PATH,
        REGISTRY_PATH,
        HYP_KEY,
      ).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const coreConfig: CoreConfig = await readCoreConfig(
        REGISTRY_PATH,
        CHAIN_NAME_1,
        CORE_READ_CONFIG_PATH_1,
      );
      expect(coreConfig.owner).to.equal(initialOwnerAddress);
      expect(coreConfig.proxyAdmin?.owner).to.be.undefined;
      // Assuming that the ProtocolFeeHook is used for deployment
      const defaultHookConfig = coreConfig.defaultHook as Exclude<
        CoreConfig['defaultHook'],
        string
      >;
      expect(defaultHookConfig.type).to.equal(
        HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      expect((defaultHookConfig as IgpConfig).owner).to.equal(
        initialOwnerAddress,
      );
    });
  });

  describe('hyperlane cosmosnative core deploy --yes', () => {
    it('should fail if the --chain flag is not provided but the --yes flag is', async () => {
      const steps: TestPromptAction[] = [SETUP_CHAIN_SIGNER_MANUALLY_STEP];

      const output = hyperlaneCoreDeployRaw(
        CORE_CONFIG_PATH,
        REGISTRY_PATH,
        undefined,
        true,
      )
        .nothrow()
        .stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(1);
      expect(finalOutput.text().includes('No chain provided')).to.be.true;
    });
  });

  describe('hyperlane cosmosnative core deploy --key ...', () => {
    it('should create a core deployment with the signer as the mailbox owner', async () => {
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        {
          check: (currentOutput: string) =>
            currentOutput.includes('--Mainnet Chains--'),
          // Scroll down through the mainnet chains list and select hyp1
          input: `${KeyBoardKeys.ARROW_DOWN.repeat(1)}}${KeyBoardKeys.ENTER}`,
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
        REGISTRY_PATH,
        HYP_KEY,
      ).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const coreConfig: CoreConfig = await readCoreConfig(
        REGISTRY_PATH,
        CHAIN_NAME_1,
        CORE_READ_CONFIG_PATH_1,
      );
      expect(coreConfig.owner).to.equal(initialOwnerAddress);
      expect(coreConfig.proxyAdmin?.owner).to.be.undefined;
      // Assuming that the ProtocolFeeHook is used for deployment
      const defaultHookConfig = coreConfig.defaultHook as Exclude<
        CoreConfig['defaultHook'],
        string
      >;
      expect(defaultHookConfig.type).to.equal(
        HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      expect((defaultHookConfig as IgpConfig).owner).to.equal(
        initialOwnerAddress,
      );
    });
  });

  describe('HYP_KEY= ... hyperlane cosmosnative core deploy', () => {
    it('should create a core deployment with the signer as the mailbox owner', async () => {
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        {
          check: (currentOutput: string) =>
            currentOutput.includes('--Mainnet Chains--'),
          // Scroll down through the mainnet chains list and select hyp1
          input: `${KeyBoardKeys.ARROW_DOWN.repeat(1)}}${KeyBoardKeys.ENTER}`,
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
        REGISTRY_PATH,
        undefined,
        undefined,
        HYP_KEY,
      ).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const coreConfig: CoreConfig = await readCoreConfig(
        REGISTRY_PATH,
        CHAIN_NAME_1,
        CORE_READ_CONFIG_PATH_1,
      );
      expect(coreConfig.owner).to.equal(initialOwnerAddress);
      expect(coreConfig.proxyAdmin?.owner).to.be.undefined;
      // Assuming that the ProtocolFeeHook is used for deployment
      const defaultHookConfig = coreConfig.defaultHook as Exclude<
        CoreConfig['defaultHook'],
        string
      >;
      expect(defaultHookConfig.type).to.equal(
        HookType.INTERCHAIN_GAS_PAYMASTER,
      );
      expect((defaultHookConfig as IgpConfig).owner).to.equal(
        initialOwnerAddress,
      );
    });
  });

  describe('hyperlane cosmosnative core deploy --yes --key ...', () => {
    it('should create a core deployment with the signer as the mailbox owner', async () => {
      await hyperlaneCoreDeploy(
        REGISTRY_PATH,
        HYP_KEY,
        CHAIN_NAME_1,
        CORE_CONFIG_PATH,
      );

      const coreConfig: CoreConfig = await readCoreConfig(
        REGISTRY_PATH,
        CHAIN_NAME_1,
        CORE_READ_CONFIG_PATH_1,
      );

      expect(coreConfig.owner).to.equal(initialOwnerAddress);
      expect(coreConfig.proxyAdmin?.owner).to.be.undefined;
      // Assuming that the ProtocolFeeHook is used for deployment
      expect((coreConfig.defaultHook as IgpConfig).owner).to.equal(
        initialOwnerAddress,
      );
    });

    it('should create a core deployment with the mailbox owner set to the address in the config', async () => {
      const coreConfig: CoreConfig = await readYamlOrJson(CORE_CONFIG_PATH);

      const newOwner = await randomCosmosAddress(
        chainMetadata.bech32Prefix || 'hyp',
      );

      coreConfig.owner = newOwner;
      writeYamlOrJson(CORE_READ_CONFIG_PATH_1, coreConfig);

      // Deploy the core contracts with the updated mailbox owner
      await hyperlaneCoreDeploy(
        REGISTRY_PATH,
        HYP_KEY,
        CHAIN_NAME_1,
        CORE_READ_CONFIG_PATH_1,
      );

      // Verify that the owner has been set correctly without modifying any other owner values
      const updatedConfig: CoreConfig = await readCoreConfig(
        REGISTRY_PATH,
        CHAIN_NAME_1,
        CORE_READ_CONFIG_PATH_1,
      );

      expect(updatedConfig.owner.toLowerCase()).to.equal(newOwner);
      expect(updatedConfig.proxyAdmin?.owner).to.be.undefined;
      // Assuming that the ProtocolFeeHook is used for deployment
      expect((updatedConfig.defaultHook as IgpConfig).owner).to.equal(
        initialOwnerAddress,
      );
    });

    it('should create a core deployment with ProxyAdmin owner of the mailbox set to the address in the config', async () => {
      const coreConfig: CoreConfig = await readYamlOrJson(CORE_CONFIG_PATH);

      const newOwner = await randomCosmosAddress(
        chainMetadata.bech32Prefix || 'hyp',
      );

      coreConfig.proxyAdmin = { owner: newOwner };
      writeYamlOrJson(CORE_READ_CONFIG_PATH_1, coreConfig);

      // Deploy the core contracts with the updated mailbox owner
      await hyperlaneCoreDeploy(
        REGISTRY_PATH,
        HYP_KEY,
        CHAIN_NAME_1,
        CORE_READ_CONFIG_PATH_1,
      );

      // Verify that the owner has been set correctly without modifying any other owner values
      const updatedConfig: CoreConfig = await readCoreConfig(
        REGISTRY_PATH,
        CHAIN_NAME_1,
        CORE_READ_CONFIG_PATH_1,
      );

      expect(updatedConfig.owner).to.equal(initialOwnerAddress);
      expect(updatedConfig.proxyAdmin?.owner).to.be.undefined;
      // Assuming that the ProtocolFeeHook is used for deployment
      expect((updatedConfig.defaultHook as IgpConfig).owner).to.equal(
        initialOwnerAddress,
      );
    });
  });
});
