import { expect } from 'chai';
import { Wallet } from 'ethers';

import { CoreConfig, HookType, randomAddress } from '@hyperlane-xyz/sdk';
import { normalizeAddress } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';
import { hyperlaneCoreInit } from '../commands/core.js';
import {
  ANVIL_KEY,
  CORE_CONFIG_PATH_2,
  DEFAULT_E2E_TEST_TIMEOUT,
  KeyBoardKeys,
  asyncStreamInputWrite,
} from '../commands/helpers.js';

describe('hyperlane core init e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  before(async () => {
    // await deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY);
  });

  describe('hyperlane core init', () => {
    it('should successfully generate the core contract deployment config', async () => {
      const output = hyperlaneCoreInit(CORE_CONFIG_PATH_2).stdio('pipe');

      const owner = normalizeAddress(randomAddress());
      const feeHookOwner = normalizeAddress(randomAddress());

      let expectedStep = 0;
      for await (const out of output.stdout) {
        const currentLine: string = out.toString();

        if (
          expectedStep === 0 &&
          currentLine.includes('Enter the desired owner address:')
        ) {
          await asyncStreamInputWrite(
            output.stdin,
            `${owner}${KeyBoardKeys.ENTER}`,
          );
          expectedStep++;
        } else if (
          expectedStep === 1 &&
          currentLine.includes(
            'For trusted relayer ISM, enter relayer address:',
          )
        ) {
          await asyncStreamInputWrite(
            output.stdin,
            `${owner}${KeyBoardKeys.ENTER}`,
          );
          expectedStep++;
        } else if (
          expectedStep === 2 &&
          currentLine.includes('For Protocol Fee Hook, enter owner address:')
        ) {
          await asyncStreamInputWrite(
            output.stdin,
            `${feeHookOwner}${KeyBoardKeys.ENTER}`,
          );
          expectedStep++;
        } else if (
          expectedStep === 3 &&
          currentLine.match(/Use this same address \((.*?)\) for/)
        ) {
          await asyncStreamInputWrite(output.stdin, KeyBoardKeys.ENTER);
          expectedStep++;
        }
      }

      const finalOutput = await output;

      expect(finalOutput.exitCode).to.equal(0);

      const deploymentCoreConfig: CoreConfig =
        readYamlOrJson(CORE_CONFIG_PATH_2);
      expect(deploymentCoreConfig.owner).to.equal(owner);
      expect(deploymentCoreConfig.proxyAdmin?.owner).to.equal(owner);

      const defaultHookConfig = deploymentCoreConfig.defaultHook as Exclude<
        CoreConfig['defaultHook'],
        string
      >;
      expect(defaultHookConfig.type).to.equal(HookType.MERKLE_TREE);

      const requiredHookConfig = deploymentCoreConfig.requiredHook as Exclude<
        CoreConfig['requiredHook'],
        string
      >;
      expect(requiredHookConfig.type).to.equal(HookType.PROTOCOL_FEE);
      expect(normalizeAddress((requiredHookConfig as any).owner)).to.equal(
        feeHookOwner,
      );
      expect(
        normalizeAddress((requiredHookConfig as any).beneficiary),
      ).to.equal(feeHookOwner);
    });
  });

  describe('hyperlane core init --key ...', () => {
    it('should successfully generate the core contract deployment config when confirming owner prompts', async () => {
      const output = hyperlaneCoreInit(CORE_CONFIG_PATH_2, ANVIL_KEY).stdio(
        'pipe',
      );

      const owner = new Wallet(ANVIL_KEY).address;
      let expectedStep = 0;
      for await (const out of output.stdout) {
        const currentLine: string = out.toString();

        if (
          expectedStep === 0 &&
          currentLine.includes('Detected owner address as')
        ) {
          await asyncStreamInputWrite(output.stdin, `${KeyBoardKeys.ENTER}`);
          expectedStep++;
        } else if (
          expectedStep === 1 &&
          currentLine.match(/Use this same address \((.*?)\) for/)
        ) {
          await asyncStreamInputWrite(output.stdin, KeyBoardKeys.ENTER);
          expectedStep++;
        }
      }

      const finalOutput = await output;

      expect(finalOutput.exitCode).to.equal(0);

      const deploymentCoreConfig: CoreConfig =
        readYamlOrJson(CORE_CONFIG_PATH_2);
      expect(deploymentCoreConfig.owner).to.equal(owner);
      expect(deploymentCoreConfig.proxyAdmin?.owner).to.equal(owner);

      const defaultHookConfig = deploymentCoreConfig.defaultHook as Exclude<
        CoreConfig['defaultHook'],
        string
      >;
      expect(defaultHookConfig.type).to.equal(HookType.MERKLE_TREE);

      const requiredHookConfig = deploymentCoreConfig.requiredHook as Exclude<
        CoreConfig['requiredHook'],
        string
      >;
      expect(requiredHookConfig.type).to.equal(HookType.PROTOCOL_FEE);
      expect(normalizeAddress((requiredHookConfig as any).owner)).to.equal(
        owner,
      );
      expect(
        normalizeAddress((requiredHookConfig as any).beneficiary),
      ).to.equal(owner);
    });

    it('should successfully generate the core contract deployment config when not confirming owner prompts', async () => {
      const output = hyperlaneCoreInit(CORE_CONFIG_PATH_2, ANVIL_KEY).stdio(
        'pipe',
      );

      const owner = new Wallet(ANVIL_KEY).address;
      const feeHookOwner = normalizeAddress(randomAddress());
      let expectedStep = 0;
      for await (const out of output.stdout) {
        const currentLine: string = out.toString();

        if (
          expectedStep === 0 &&
          currentLine.includes('Detected owner address as')
        ) {
          await asyncStreamInputWrite(output.stdin, `${KeyBoardKeys.ENTER}`);
          expectedStep++;
        } else if (
          expectedStep === 1 &&
          currentLine.match(/Use this same address \((.*?)\) for/)
        ) {
          await asyncStreamInputWrite(output.stdin, `no${KeyBoardKeys.ENTER}`);
          expectedStep++;
        } else if (
          expectedStep === 2 &&
          currentLine.includes('Enter beneficiary address for')
        ) {
          await asyncStreamInputWrite(
            output.stdin,
            `${feeHookOwner}${KeyBoardKeys.ENTER}`,
          );
          expectedStep++;
        }
      }

      const finalOutput = await output;

      expect(finalOutput.exitCode).to.equal(0);

      const deploymentCoreConfig: CoreConfig =
        readYamlOrJson(CORE_CONFIG_PATH_2);
      expect(deploymentCoreConfig.owner).to.equal(owner);
      expect(deploymentCoreConfig.proxyAdmin?.owner).to.equal(owner);

      const defaultHookConfig = deploymentCoreConfig.defaultHook as Exclude<
        CoreConfig['defaultHook'],
        string
      >;
      expect(defaultHookConfig.type).to.equal(HookType.MERKLE_TREE);

      const requiredHookConfig = deploymentCoreConfig.requiredHook as Exclude<
        CoreConfig['requiredHook'],
        string
      >;
      expect(requiredHookConfig.type).to.equal(HookType.PROTOCOL_FEE);
      expect(normalizeAddress((requiredHookConfig as any).owner)).to.equal(
        owner,
      );
      expect(
        normalizeAddress((requiredHookConfig as any).beneficiary),
      ).to.equal(feeHookOwner);
    });
  });
});
