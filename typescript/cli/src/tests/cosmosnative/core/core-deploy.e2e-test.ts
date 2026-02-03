import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { expect } from 'chai';

import { CosmosNativeSigner } from '@hyperlane-xyz/cosmos-sdk';
import { type AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  type ChainMetadata,
  type CoreConfig,
  type DomainRoutingIsmConfig,
  HookType,
  type IgpConfig,
  IsmType,
  type ProtocolReceipt,
  type ProtocolTransaction,
  randomCosmosAddress,
} from '@hyperlane-xyz/sdk';
import { type Address, assert } from '@hyperlane-xyz/utils';

import {
  readYamlOrJsonOrThrow,
  writeYamlOrJson,
} from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  KeyBoardKeys,
  SELECT_MAINNET_CHAIN_TYPE_STEP,
  SETUP_CHAIN_SIGNER_MANUALLY_STEP,
  type TestPromptAction,
  handlePrompts,
} from '../../commands/helpers.js';
import { BURN_ADDRESS_BY_PROTOCOL } from '../../constants.js';
import {
  CHAIN_1_METADATA_PATH,
  CHAIN_NAME_1,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_1,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY,
  REGISTRY_PATH,
} from '../consts.js';

describe('hyperlane cosmosnative core deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_1,
  );

  let signer: AltVM.ISigner<
    ProtocolTransaction<ProtocolType.CosmosNative>,
    ProtocolReceipt<ProtocolType.CosmosNative>
  >;
  let initialOwnerAddress: Address;
  let chainMetadata: ChainMetadata;

  before(async () => {
    chainMetadata = readYamlOrJsonOrThrow(CHAIN_1_METADATA_PATH);

    assert(chainMetadata.gasPrice, 'gasPrice not defined in chain metadata');

    const wallet = await DirectSecp256k1Wallet.fromKey(
      Uint8Array.from(Buffer.from(HYP_KEY, 'hex')),
      'hyp',
    );

    signer = await CosmosNativeSigner.connectWithSigner(
      chainMetadata.rpcUrls.map((rpc) => rpc.http),
      wallet,
      {
        metadata: chainMetadata,
      },
    );

    initialOwnerAddress = signer.getSignerAddress();
  });

  describe('hyperlane cosmosnative core deploy', () => {
    it('should create a core deployment with the signer as the mailbox owner', async () => {
      const steps: TestPromptAction[] = [
        SELECT_MAINNET_CHAIN_TYPE_STEP,
        {
          check: (currentOutput: string) =>
            currentOutput.includes('--Mainnet Chains--'),
          // Scroll down through the mainnet chains list and select hyp1
          input: `${KeyBoardKeys.ARROW_DOWN.repeat(1)}${KeyBoardKeys.ENTER}`,
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

      const output = hyperlaneCore.deployRaw(HYP_KEY).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const coreConfig: CoreConfig = await hyperlaneCore.readConfig();
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
      const steps: TestPromptAction[] = [
        SETUP_CHAIN_SIGNER_MANUALLY_STEP(HYP_KEY),
      ];

      const output = hyperlaneCore
        .deployRaw(undefined, undefined, true)
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
          input: `${KeyBoardKeys.ARROW_DOWN.repeat(1)}${KeyBoardKeys.ENTER}`,
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

      const output = hyperlaneCore.deployRaw(HYP_KEY).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const coreConfig: CoreConfig = await hyperlaneCore.readConfig();
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
          input: `${KeyBoardKeys.ARROW_DOWN.repeat(1)}${KeyBoardKeys.ENTER}`,
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

      const output = hyperlaneCore
        .deployRaw(undefined, HYP_KEY, undefined)
        .stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const coreConfig: CoreConfig = await hyperlaneCore.readConfig();
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
      await hyperlaneCore.deploy(HYP_KEY);

      const coreConfig: CoreConfig = await hyperlaneCore.readConfig();

      expect(coreConfig.owner).to.equal(initialOwnerAddress);
      expect(coreConfig.proxyAdmin?.owner).to.be.undefined;
      // Assuming that the ProtocolFeeHook is used for deployment
      expect((coreConfig.defaultHook as IgpConfig).owner).to.equal(
        initialOwnerAddress,
      );
    });

    it('should create a core deployment with the mailbox owner set to the address in the config', async () => {
      const coreConfig = readYamlOrJsonOrThrow<CoreConfig>(CORE_CONFIG_PATH);

      const newOwner = await randomCosmosAddress(
        chainMetadata.bech32Prefix || 'hyp',
      );

      coreConfig.owner = newOwner;
      writeYamlOrJson(CORE_READ_CONFIG_PATH_1, coreConfig);
      hyperlaneCore.setCoreInputPath(CORE_READ_CONFIG_PATH_1);

      // Deploy the core contracts with the updated mailbox owner
      await hyperlaneCore.deploy(HYP_KEY);

      // Verify that the owner has been set correctly without modifying any other owner values
      const updatedConfig: CoreConfig = await hyperlaneCore.readConfig();

      expect(updatedConfig.owner.toLowerCase()).to.equal(newOwner);
      expect(updatedConfig.proxyAdmin?.owner).to.be.undefined;
      // Assuming that the ProtocolFeeHook is used for deployment
      expect((updatedConfig.defaultHook as IgpConfig).owner).to.equal(
        initialOwnerAddress,
      );
    });

    it('should create a core deployment with the provided address as the owner of the defaultHook', async () => {
      const coreConfig = readYamlOrJsonOrThrow<CoreConfig>(CORE_CONFIG_PATH);

      coreConfig.owner = initialOwnerAddress;

      const defaultHookConfig = coreConfig.defaultHook;
      assert(
        typeof defaultHookConfig !== 'string' &&
          defaultHookConfig.type === HookType.INTERCHAIN_GAS_PAYMASTER,
        `Expected defaultHook in deploy config to be of type ${HookType.INTERCHAIN_GAS_PAYMASTER}`,
      );
      defaultHookConfig.owner = BURN_ADDRESS_BY_PROTOCOL.cosmosnative;

      coreConfig.defaultHook = defaultHookConfig;

      writeYamlOrJson(CORE_READ_CONFIG_PATH_1, coreConfig);
      hyperlaneCore.setCoreInputPath(CORE_READ_CONFIG_PATH_1);

      await hyperlaneCore.deploy(HYP_KEY);

      const derivedCoreConfig = await hyperlaneCore.readConfig();

      expect(derivedCoreConfig.owner).to.equal(initialOwnerAddress);
      expect((derivedCoreConfig.defaultHook as IgpConfig).owner).to.equal(
        BURN_ADDRESS_BY_PROTOCOL.cosmosnative,
      );
    });

    it('should create a core deployment with the provided address as the owner of the defaultIsm', async () => {
      const coreConfig = readYamlOrJsonOrThrow<CoreConfig>(CORE_CONFIG_PATH);

      coreConfig.owner = initialOwnerAddress;

      const defaultHookConfig = coreConfig.defaultHook;
      assert(
        typeof defaultHookConfig !== 'string' &&
          defaultHookConfig.type === HookType.INTERCHAIN_GAS_PAYMASTER,
        `Expected defaultHook in deploy config to be of type ${HookType.INTERCHAIN_GAS_PAYMASTER}`,
      );
      defaultHookConfig.owner = initialOwnerAddress;

      // Replace the default multisig ISM with a routing ISM
      const routingIsmConfig: DomainRoutingIsmConfig = {
        type: IsmType.ROUTING,
        owner: BURN_ADDRESS_BY_PROTOCOL.cosmosnative,
        domains: {
          // Keep the original multisig ISM as a domain route
          hyp1: coreConfig.defaultIsm,
        },
      };

      coreConfig.defaultHook = defaultHookConfig;
      coreConfig.defaultIsm = routingIsmConfig;

      writeYamlOrJson(CORE_READ_CONFIG_PATH_1, coreConfig);
      hyperlaneCore.setCoreInputPath(CORE_READ_CONFIG_PATH_1);

      await hyperlaneCore.deploy(HYP_KEY);

      const derivedCoreConfig = await hyperlaneCore.readConfig();

      expect(derivedCoreConfig.owner).to.equal(initialOwnerAddress);
      expect((derivedCoreConfig.defaultHook as IgpConfig).owner).to.equal(
        initialOwnerAddress,
      );
      assert(
        typeof derivedCoreConfig.defaultIsm !== 'string' &&
          derivedCoreConfig.defaultIsm.type === IsmType.ROUTING,
        `Expected deployed defaultIsm to be of type ${IsmType.ROUTING}`,
      );
      expect(
        (derivedCoreConfig.defaultIsm as DomainRoutingIsmConfig).owner,
      ).to.equal(BURN_ADDRESS_BY_PROTOCOL.cosmosnative);
    });
  });
});
