import { expect } from 'chai';
import { Wallet } from 'ethers';

import {
  CoreConfig,
  HookType,
  MerkleTreeHookConfig,
  ProtocolFeeHookConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address, normalizeAddress } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../../utils/files.js';
import { hyperlaneCoreInit } from '../commands/core.js';
import {
  ANVIL_KEY,
  CONFIRM_DETECTED_OWNER_STEP,
  CORE_CONFIG_PATH_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  KeyBoardKeys,
  TestPromptAction,
  handlePrompts,
} from '../commands/helpers.js';

describe('hyperlane core init e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

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
      const output = hyperlaneCoreInit(CORE_CONFIG_PATH_2).stdio('pipe');

      const owner = normalizeAddress(randomAddress());
      const feeHookOwner = normalizeAddress(randomAddress());
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

      const deploymentCoreConfig: CoreConfig =
        readYamlOrJson(CORE_CONFIG_PATH_2);
      assertCoreInitConfig(deploymentCoreConfig, owner, feeHookOwner);
    });
  });

  describe('HYP_KEY=... hyperlane core init', () => {
    it('should successfully generate the core contract deployment config when confirming owner prompts', async () => {
      const owner = new Wallet(ANVIL_KEY).address;
      const steps: TestPromptAction[] = [
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput) =>
            !!currentOutput.match(/Use this same address \((.*?)\) for/),
          input: KeyBoardKeys.ENTER,
        },
      ];

      const output = hyperlaneCoreInit(
        CORE_CONFIG_PATH_2,
        undefined,
        ANVIL_KEY,
      ).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const deploymentCoreConfig: CoreConfig =
        readYamlOrJson(CORE_CONFIG_PATH_2);
      assertCoreInitConfig(deploymentCoreConfig, owner);
    });

    it('should successfully generate the core contract deployment config when not confirming owner prompts', async () => {
      const owner = new Wallet(ANVIL_KEY).address;
      const feeHookOwner = normalizeAddress(randomAddress());
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
        CORE_CONFIG_PATH_2,
        undefined,
        ANVIL_KEY,
      ).stdio('pipe');

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const deploymentCoreConfig: CoreConfig =
        readYamlOrJson(CORE_CONFIG_PATH_2);
      assertCoreInitConfig(
        deploymentCoreConfig,
        owner,
        undefined,
        feeHookOwner,
      );
    });
  });

  describe('hyperlane core init --key ...', () => {
    it('should successfully generate the core contract deployment config when confirming owner prompts', async () => {
      const owner = new Wallet(ANVIL_KEY).address;
      const steps: TestPromptAction[] = [
        CONFIRM_DETECTED_OWNER_STEP,
        {
          check: (currentOutput) =>
            !!currentOutput.match(/Use this same address \((.*?)\) for/),
          input: KeyBoardKeys.ENTER,
        },
      ];

      const output = hyperlaneCoreInit(CORE_CONFIG_PATH_2, ANVIL_KEY).stdio(
        'pipe',
      );

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const deploymentCoreConfig: CoreConfig =
        readYamlOrJson(CORE_CONFIG_PATH_2);
      assertCoreInitConfig(deploymentCoreConfig, owner);
    });

    it('should successfully generate the core contract deployment config when not confirming owner prompts', async () => {
      const owner = new Wallet(ANVIL_KEY).address;
      const feeHookOwner = normalizeAddress(randomAddress());
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

      const output = hyperlaneCoreInit(CORE_CONFIG_PATH_2, ANVIL_KEY).stdio(
        'pipe',
      );

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);

      const deploymentCoreConfig: CoreConfig =
        readYamlOrJson(CORE_CONFIG_PATH_2);
      assertCoreInitConfig(
        deploymentCoreConfig,
        owner,
        undefined,
        feeHookOwner,
      );
    });
  });
});
