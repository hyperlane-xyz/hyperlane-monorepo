import { expect } from 'chai';
import { Wallet, constants } from 'ethers';

import { ERC20Test } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainName,
  HookType,
  HypTokenRouterConfig,
  IsmType,
  TokenType,
  WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  KeyBoardKeys,
  TestPromptAction,
  WARP_DEPLOY_OUTPUT_PATH,
  deployOrUseExistingCore,
  deployToken,
  getCombinedWarpRoutePath,
  handlePrompts,
} from '../commands/helpers.js';
import {
  hyperlaneWarpCheck,
  hyperlaneWarpCheckRaw,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';

describe('hyperlane warp check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let token: ERC20Test;
  let tokenSymbol: string;
  let ownerAddress: Address;

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    tokenSymbol = await token.symbol();
    ownerAddress = new Wallet(ANVIL_KEY).address;
  });

  async function deployAndExportWarpRoute(
    collateralTokenSymbol: string,
    collateralTokenAddress: Address,
  ): Promise<WarpRouteDeployConfig> {
    const COMBINED_WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath(
      collateralTokenSymbol,
      [CHAIN_NAME_2, CHAIN_NAME_3],
    );
    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: collateralTokenAddress,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

    const chain2WarpConfig = await readWarpConfig(
      CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
      WARP_DEPLOY_OUTPUT_PATH,
    );
    const chain3WarpConfig = await readWarpConfig(
      CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
      WARP_DEPLOY_OUTPUT_PATH,
    );
    const warpReadResult = {
      [CHAIN_NAME_2]: chain2WarpConfig[CHAIN_NAME_2],
      [CHAIN_NAME_3]: chain3WarpConfig[CHAIN_NAME_3],
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpReadResult);

    return warpReadResult;
  }

  describe('HYP_KEY=... hyperlane warp check --config ...', () => {});

  describe('hyperlane warp check --key ... --config ...', () => {
    it(`should exit early if no symbol, chain or warp file have been provided`, async function () {
      await deployAndExportWarpRoute(tokenSymbol, token.address);

      const finalOutput = await hyperlaneWarpCheckRaw({
        privateKey: ANVIL_KEY,
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      })
        .stdio('pipe')
        .nothrow();

      expect(finalOutput.exitCode).to.equal(1);
      expect(finalOutput.text()).to.include(
        'Please specify either a symbol, chain and address or warp file',
      );
    });
  });

  describe('hyperlane warp check --symbol ... --config ...', () => {
    it(`should not find any differences between the on chain config and the local one`, async function () {
      await deployAndExportWarpRoute(tokenSymbol, token.address);

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
        },
        {
          check: (currentOutput) =>
            currentOutput.includes('Please enter the private key for chain'),
          input: `${ANVIL_KEY}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = hyperlaneWarpCheckRaw({
        symbol: tokenSymbol,
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      })
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);
      expect(finalOutput.text()).to.include('No violations found');
    });
  });

  describe('hyperlane warp check --symbol ... --config ... --key ...', () => {
    it(`should not find any differences between the on chain config and the local one`, async function () {
      await deployAndExportWarpRoute(tokenSymbol, token.address);

      const output = await hyperlaneWarpCheck(
        WARP_DEPLOY_OUTPUT_PATH,
        tokenSymbol,
      );

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.includes('No violations found');
    });

    it(`should find differences between the local config and the on chain config`, async function () {
      const warpDeployConfig = await deployAndExportWarpRoute(
        tokenSymbol,
        token.address,
      );

      const wrongOwner = randomAddress();
      warpDeployConfig[CHAIN_NAME_3].owner = wrongOwner;

      const expectedDiffText = `EXPECTED: "${wrongOwner.toLowerCase()}"\n`;
      const expectedActualText = `ACTUAL: "${ownerAddress.toLowerCase()}"\n`;

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);

      const output = await hyperlaneWarpCheck(
        WARP_DEPLOY_OUTPUT_PATH,
        tokenSymbol,
      ).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text().includes(expectedDiffText)).to.be.true;
      expect(output.text().includes(expectedActualText)).to.be.true;
    });
  });

  describe('Optional checks', () => {
    async function deployAndExportSingleChainWarpRoute(
      chainName: ChainName,
      warpConfig: HypTokenRouterConfig,
    ): Promise<WarpRouteDeployConfig> {
      const deployConfig: WarpRouteDeployConfig = {
        [chainName]: warpConfig,
      };

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, deployConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      const WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath(tokenSymbol, [
        chainName,
      ]);

      const derivedConfig = await readWarpConfig(
        chainName,
        WARP_CORE_CONFIG_PATH,
        WARP_DEPLOY_OUTPUT_PATH,
      );

      return derivedConfig;
    }

    it(`should not check the hook config if it is not provided in the input file`, async function () {
      const derivedConfig = await deployAndExportSingleChainWarpRoute(
        CHAIN_NAME_2,
        {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain2Addresses.mailbox,
          hook: {
            type: HookType.MERKLE_TREE,
          },
          owner: ownerAddress,
        },
      );

      derivedConfig[CHAIN_NAME_2].hook = undefined;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, derivedConfig);

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Select from matching warp routes'),
          input: `${KeyBoardKeys.ARROW_DOWN}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = hyperlaneWarpCheck(WARP_DEPLOY_OUTPUT_PATH, tokenSymbol)
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);
      expect(finalOutput.text()).to.include('No violations found');
    });

    it(`should check the hook config if it is provided in the input file and find differences`, async function () {
      const derivedConfig = await deployAndExportSingleChainWarpRoute(
        CHAIN_NAME_2,
        {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
      );

      derivedConfig[CHAIN_NAME_2].hook = {
        type: HookType.MERKLE_TREE,
      };
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, derivedConfig);

      const expectedDiffText = `type: ${HookType.MERKLE_TREE}\n`;
      const expectedActualText = `ACTUAL: "${constants.AddressZero}"\n`;

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Select from matching warp routes'),
          input: `${KeyBoardKeys.ARROW_DOWN}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = hyperlaneWarpCheck(WARP_DEPLOY_OUTPUT_PATH, tokenSymbol)
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(1);
      expect(finalOutput.text()).to.include(expectedDiffText);
      expect(finalOutput.text()).to.include(expectedActualText);
    });

    it(`should not check the ism config if it is not provided in the input file`, async function () {
      const derivedConfig = await deployAndExportSingleChainWarpRoute(
        CHAIN_NAME_2,
        {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain2Addresses.mailbox,
          interchainSecurityModule: {
            type: IsmType.TRUSTED_RELAYER,
            relayer: randomAddress(),
          },
          owner: ownerAddress,
        },
      );

      derivedConfig[CHAIN_NAME_2].interchainSecurityModule = undefined;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, derivedConfig);

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Select from matching warp routes'),
          input: `${KeyBoardKeys.ARROW_DOWN}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = hyperlaneWarpCheck(WARP_DEPLOY_OUTPUT_PATH, tokenSymbol)
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(0);
      expect(finalOutput.text()).to.include('No violations found');
    });

    it(`should check the ism config if it is provided in the input file and find differences`, async function () {
      const derivedConfig = await deployAndExportSingleChainWarpRoute(
        CHAIN_NAME_2,
        {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
        },
      );

      derivedConfig[CHAIN_NAME_2].interchainSecurityModule = {
        type: IsmType.TRUSTED_RELAYER,
        relayer: randomAddress(),
      };
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, derivedConfig);

      const expectedDiffText = `type: ${IsmType.TRUSTED_RELAYER}\n`;
      const expectedActualText = `ACTUAL: "${constants.AddressZero}"\n`;

      const steps: TestPromptAction[] = [
        {
          check: (currentOutput) =>
            currentOutput.includes('Select from matching warp routes'),
          input: `${KeyBoardKeys.ARROW_DOWN}${KeyBoardKeys.ENTER}`,
        },
      ];

      const output = hyperlaneWarpCheck(WARP_DEPLOY_OUTPUT_PATH, tokenSymbol)
        .stdio('pipe')
        .nothrow();

      const finalOutput = await handlePrompts(output, steps);

      expect(finalOutput.exitCode).to.equal(1);
      expect(finalOutput.text()).to.include(expectedDiffText);
      expect(finalOutput.text()).to.include(expectedActualText);
    });
  });
});
