import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice } from '@cosmjs/stargate';
import { expect } from 'chai';
import { Wallet } from 'ethers';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import {
  ChainMetadata,
  CoreConfig,
  HookType,
  MerkleTreeHookConfig,
  ProtocolFeeHookConfig,
  randomCosmosAddress,
} from '@hyperlane-xyz/sdk';
import { Address, assert, normalizeAddress } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../../utils/files.js';
import { hyperlaneCoreInit } from '../commands/core.js';
import {
  CHAIN_1_METADATA_PATH,
  CONFIRM_DETECTED_OWNER_STEP,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY,
  KeyBoardKeys,
  REGISTRY_PATH,
  TestPromptAction,
  handlePrompts,
} from '../commands/helpers.js';

describe.skip('hyperlane cosmosnative core init e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let signer: SigningHyperlaneModuleClient;
  let initialOwnerAddress: Address;

  before(async () => {
    const chainMetadata: ChainMetadata = readYamlOrJson(CHAIN_1_METADATA_PATH);

    const wallet = await DirectSecp256k1Wallet.fromKey(
      Buffer.from(HYP_KEY, 'hex'),
      'hyp',
    );

    assert(chainMetadata.gasPrice, 'gasPrice not defined in chain metadata');

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

  function assertCoreInitConfig(
    coreConfig: CoreConfig,
    owner: Address,
    feeHookOwner: Address = owner,
    feeHookBeneficiary: Address = feeHookOwner,
  ): void {
    expect(coreConfig.owner).to.equal(owner);
    expect(coreConfig.proxyAdmin?.owner).to.equal(owner);

    const defaultHookConfig = coreConfig.defaultHook as MerkleTreeHookConfig;
    expect(defaultHookConfig.type).to.equal(HookType.MERKLE_TREE);

    const requiredHookConfig = coreConfig.requiredHook as ProtocolFeeHookConfig;
    expect(requiredHookConfig.type).to.equal(HookType.PROTOCOL_FEE);
    expect(normalizeAddress(requiredHookConfig.owner)).to.equal(feeHookOwner);
    expect(normalizeAddress(requiredHookConfig.beneficiary)).to.equal(
      feeHookBeneficiary,
    );
  }

  describe('hyperlane core init', () => {
    it('should successfully generate the core contract deployment config', async () => {
      const output = hyperlaneCoreInit(CORE_CONFIG_PATH, REGISTRY_PATH).stdio(
        'pipe',
      );

      const owner = normalizeAddress(await randomCosmosAddress('hyp'));
      const feeHookOwner = normalizeAddress(await randomCosmosAddress('hyp'));
      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Enter the desired owner address:'),
          input: `${owner}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes(
              'For trusted relayer ISM, enter relayer address:',
            ),
          input: `${owner}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes(
              'For Protocol Fee Hook, enter owner address:',
            ),
          input: `${feeHookOwner}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            !!currentOutput.match(/Use this same address \((.*?)\) for/),
          input: KeyBoardKeys.ENTER,
        },
      ];

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const deploymentCoreConfig: CoreConfig = readYamlOrJson(CORE_CONFIG_PATH);
      assertCoreInitConfig(deploymentCoreConfig, owner, feeHookOwner);
    });
  });

  describe('HYP_KEY=... hyperlane core init', () => {
    it('should successfully generate the core contract deployment config when confirming owner prompts', async () => {
      const steps: TestPromptAction[] = [
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput) =>
            !!currentOutput.match(/Use this same address \((.*?)\) for/),
          input: KeyBoardKeys.ENTER,
        },
      ];

      const output = hyperlaneCoreInit(
        CORE_CONFIG_PATH,
        REGISTRY_PATH,
        undefined,
        HYP_KEY,
      ).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const deploymentCoreConfig: CoreConfig = readYamlOrJson(CORE_CONFIG_PATH);
      assertCoreInitConfig(deploymentCoreConfig, initialOwnerAddress);
    });

    it('should successfully generate the core contract deployment config when not confirming owner prompts', async () => {
      const feeHookOwner = await randomCosmosAddress('hyp');
      const steps: TestPromptAction[] = [
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput) =>
            !!currentOutput.match(/Use this same address \((.*?)\) for/),
          input: `no${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Enter beneficiary address for'),
          input: `${feeHookOwner}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = hyperlaneCoreInit(
        CORE_CONFIG_PATH,
        REGISTRY_PATH,
        undefined,
        HYP_KEY,
      ).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const deploymentCoreConfig: CoreConfig = readYamlOrJson(CORE_CONFIG_PATH);
      assertCoreInitConfig(
        deploymentCoreConfig,
        initialOwnerAddress,
        undefined,
        feeHookOwner,
      );
    });
  });

  describe('hyperlane core init --key ...', () => {
    it('should successfully generate the core contract deployment config when confirming owner prompts', async () => {
      const owner = new Wallet(HYP_KEY).address;
      const steps: TestPromptAction[] = [
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput) =>
            !!currentOutput.match(/Use this same address \((.*?)\) for/),
          input: KeyBoardKeys.ENTER,
        },
      ];

      const output = hyperlaneCoreInit(
        CORE_CONFIG_PATH,
        REGISTRY_PATH,
        HYP_KEY,
      ).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const deploymentCoreConfig: CoreConfig = readYamlOrJson(CORE_CONFIG_PATH);
      assertCoreInitConfig(deploymentCoreConfig, owner);
    });

    it('should successfully generate the core contract deployment config when not confirming owner prompts', async () => {
      const owner = new Wallet(HYP_KEY).address;
      const feeHookOwner = normalizeAddress(await randomCosmosAddress('hyp'));
      const steps: TestPromptAction[] = [
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput) =>
            !!currentOutput.match(/Use this same address \((.*?)\) for/),
          input: `no${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Enter beneficiary address for'),
          input: `${feeHookOwner}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = hyperlaneCoreInit(
        CORE_CONFIG_PATH,
        REGISTRY_PATH,
        HYP_KEY,
      ).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const deploymentCoreConfig: CoreConfig = readYamlOrJson(CORE_CONFIG_PATH);
      assertCoreInitConfig(
        deploymentCoreConfig,
        owner,
        undefined,
        feeHookOwner,
      );
    });
  });
});
