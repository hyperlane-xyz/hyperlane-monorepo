import { expect } from 'chai';
import { Wallet } from 'ethers';
import { zeroAddress } from 'viem';

import { ERC20Test } from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  HookConfig,
  HookType,
  IsmConfig,
  IsmType,
  MUTABLE_HOOK_TYPE,
  MUTABLE_ISM_TYPE,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  randomAddress,
  randomHookConfig,
  randomIsmConfig,
} from '@hyperlane-xyz/sdk';
import { Address, assert, deepCopy } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
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
  hyperlaneWarpApply,
  hyperlaneWarpCheck,
  hyperlaneWarpCheckRaw,
  hyperlaneWarpDeploy,
} from '../commands/warp.js';

describe('hyperlane warp check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let token: ERC20Test;
  let tokenSymbol: string;
  let ownerAddress: Address;
  let warpConfig: WarpRouteDeployConfig;

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    tokenSymbol = await token.symbol();
  });

  async function deployAndExportWarpRoute(): Promise<WarpRouteDeployConfig> {
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

    return warpConfig;
  }

  // Reset config before each test to avoid test changes intertwining
  beforeEach(async function () {
    ownerAddress = new Wallet(ANVIL_KEY).address;
    warpConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: token.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };
  });

  describe('hyperlane warp check --config ...', () => {
    it(`should exit early if no symbol, chain or warp file have been provided`, async function () {
      await deployAndExportWarpRoute();

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.include(
        'Please specify either a symbol, chain and address or warp file',
      );
    });
  });

  describe('hyperlane warp check --symbol ... --config ...', () => {
    it(`should not find any differences between the on chain config and the local one`, async function () {
      await deployAndExportWarpRoute();

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
      await deployAndExportWarpRoute();

      const output = await hyperlaneWarpCheck(
        WARP_DEPLOY_OUTPUT_PATH,
        tokenSymbol,
      );

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.includes('No violations found');
    });

    describe('when using a custom ISM', () => {
      before(async function () {
        warpConfig[CHAIN_NAME_3].interchainSecurityModule = {
          type: IsmType.TRUSTED_RELAYER,
          relayer: ownerAddress,
        };
      });

      it(`should not find any differences between the on chain config and the local one`, async function () {
        await deployAndExportWarpRoute();

        const output = await hyperlaneWarpCheck(
          WARP_DEPLOY_OUTPUT_PATH,
          tokenSymbol,
        );

        expect(output.exitCode).to.equal(0);
        expect(output.text()).to.includes('No violations found');
      });
    });

    describe('when using a custom hook', () => {
      before(async function () {
        warpConfig[CHAIN_NAME_3].hook = {
          type: HookType.PROTOCOL_FEE,
          protocolFee: '1',
          maxProtocolFee: '1',
          owner: ownerAddress,
          beneficiary: ownerAddress,
        };
      });

      it(`should not find any differences between the on chain config and the local one`, async function () {
        await deployAndExportWarpRoute();

        const output = await hyperlaneWarpCheck(
          WARP_DEPLOY_OUTPUT_PATH,
          tokenSymbol,
        );

        expect(output.exitCode).to.equal(0);
        expect(output.text()).to.includes('No violations found');
      });
    });

    it(`should find differences between the local config and the on chain config in the ism`, async function () {
      const warpDeployConfig = await deployAndExportWarpRoute();
      warpDeployConfig[CHAIN_NAME_3].interchainSecurityModule = {
        type: IsmType.TRUSTED_RELAYER,
        relayer: ownerAddress,
      };
      const expectedDiffText = `EXPECTED:`;
      const expectedActualText = `ACTUAL: "${zeroAddress.toLowerCase()}"\n`;

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);
      const output = await hyperlaneWarpCheck(
        WARP_DEPLOY_OUTPUT_PATH,
        tokenSymbol,
      )
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text().includes(expectedDiffText)).to.be.true;
      expect(output.text().includes(expectedActualText)).to.be.true;
    });

    it(`should find differences between the local config and the on chain config`, async function () {
      const warpDeployConfig = await deployAndExportWarpRoute();

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

    it(`should find differences in the remoteRouters config between the local and on chain config`, async function () {
      const warpDeployConfig = await deployAndExportWarpRoute();

      const WARP_CORE_CONFIG_PATH_2_3 = getCombinedWarpRoutePath(tokenSymbol, [
        CHAIN_NAME_2,
        CHAIN_NAME_3,
      ]);

      // Unenroll CHAIN 2 from CHAIN 3
      warpDeployConfig[CHAIN_NAME_3].remoteRouters = {};

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);
      await hyperlaneWarpApply(
        WARP_DEPLOY_OUTPUT_PATH,
        WARP_CORE_CONFIG_PATH_2_3,
      );

      // Reset the config to the original state to trigger the inconsistency
      warpDeployConfig[CHAIN_NAME_3].remoteRouters = undefined;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);

      const warpCore: WarpCoreConfig = readYamlOrJson(
        WARP_CORE_CONFIG_PATH_2_3,
      );
      const expectedActualText = `ACTUAL: ""\n`;
      const expectedDiffText = `      EXPECTED:
        address: "${warpCore.tokens[0].addressOrDenom!.toLowerCase()}"`;

      const output = await hyperlaneWarpCheck(
        WARP_DEPLOY_OUTPUT_PATH,
        tokenSymbol,
      ).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.includes(expectedDiffText);
      expect(output.text()).to.includes(expectedActualText);
    });
  });

  for (const hookType of MUTABLE_HOOK_TYPE) {
    it(`should find owner differences between the local config and the on chain config for ${hookType}`, async function () {
      warpConfig[CHAIN_NAME_3].hook = randomHookConfig(0, 2, hookType);
      await deployAndExportWarpRoute();

      const mutatedWarpConfig = deepCopy(warpConfig);

      const hookConfig: Extract<
        HookConfig,
        { type: (typeof MUTABLE_HOOK_TYPE)[number]; owner: string }
      > = mutatedWarpConfig[CHAIN_NAME_3].hook!;
      const actualOwner = hookConfig.owner;
      const wrongOwner = randomAddress();
      assert(actualOwner !== wrongOwner, 'Random owner matches actualOwner');
      hookConfig.owner = wrongOwner;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, mutatedWarpConfig);

      const expectedDiffText = `EXPECTED: "${wrongOwner.toLowerCase()}"\n`;
      const expectedActualText = `ACTUAL: "${actualOwner.toLowerCase()}"\n`;

      const output = await hyperlaneWarpCheck(
        WARP_DEPLOY_OUTPUT_PATH,
        tokenSymbol,
      ).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text().includes(expectedDiffText)).to.be.true;
      expect(output.text().includes(expectedActualText)).to.be.true;
    });
  }

  for (const ismType of MUTABLE_ISM_TYPE) {
    it(`should find owner differences between the local config and the on chain config for ${ismType}`, async function () {
      // Create a Pausable because randomIsmConfig() cannot generate it (reason: NULL type Isms)
      warpConfig[CHAIN_NAME_3].interchainSecurityModule =
        ismType === IsmType.PAUSABLE
          ? {
              type: IsmType.PAUSABLE,
              owner: randomAddress(),
              paused: true,
            }
          : randomIsmConfig(0, 2, ismType);
      await deployAndExportWarpRoute();

      const mutatedWarpConfig = deepCopy(warpConfig);

      const ismConfig: Extract<
        IsmConfig,
        { type: (typeof MUTABLE_ISM_TYPE)[number]; owner: string }
      > = mutatedWarpConfig[CHAIN_NAME_3].interchainSecurityModule;
      const actualOwner = ismConfig.owner;
      const wrongOwner = randomAddress();
      assert(actualOwner !== wrongOwner, 'Random owner matches actualOwner');
      ismConfig.owner = wrongOwner;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, mutatedWarpConfig);

      const expectedDiffText = `EXPECTED: "${wrongOwner.toLowerCase()}"\n`;
      const expectedActualText = `ACTUAL: "${actualOwner.toLowerCase()}"\n`;

      const output = await hyperlaneWarpCheck(
        WARP_DEPLOY_OUTPUT_PATH,
        tokenSymbol,
      ).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text().includes(expectedDiffText)).to.be.true;
      expect(output.text().includes(expectedActualText)).to.be.true;
    });
  }
});
