import { expect } from 'chai';
import { randomInt } from 'crypto';
import { Wallet } from 'ethers';
import { zeroAddress } from 'viem';

import { ERC20Test } from '@hyperlane-xyz/core';
import {
  ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
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
  WARP_DEPLOY_OUTPUT_PATH,
  deployOrUseExistingCore,
  deployToken,
  deployXERC20LockboxToken,
  deployXERC20VSToken,
  getCombinedWarpRoutePath,
} from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpCheckRaw,
  hyperlaneWarpDeploy,
} from '../commands/warp.js';

describe.only('hyperlane warp check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let token: ERC20Test;
  let tokenSymbol: string;
  let ownerAddress: Address;
  let combinedWarpCoreConfigPath: string;
  let warpConfig: WarpRouteDeployConfig;

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    tokenSymbol = await token.symbol();

    combinedWarpCoreConfigPath = getCombinedWarpRoutePath(tokenSymbol, [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);
  });

  async function deployAndExportWarpRoute(): Promise<WarpRouteDeployConfig> {
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    // currently warp deploy is not writing the deploy config to the registry
    // should remove this once the deploy config is written to the registry
    writeYamlOrJson(
      combinedWarpCoreConfigPath.replace('-config.yaml', '-deploy.yaml'),
      warpConfig,
    );

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

  describe('hyperlane warp check --config ... and hyperlane warp check --warp ...', () => {
    const expectedError =
      'Both --config/-wd and --warp/-wc must be provided together when using individual file paths';
    it(`should require both warp core & warp deploy config paths to be provided together`, async function () {
      await deployAndExportWarpRoute();

      const output1 = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      })
        .stdio('pipe')
        .nothrow();

      const output2 = await hyperlaneWarpCheckRaw({
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      })
        .stdio('pipe')
        .nothrow();

      expect(output1.exitCode).to.equal(1);
      expect(output1.text()).to.include(expectedError);
      expect(output2.exitCode).to.equal(1);
      expect(output2.text()).to.include(expectedError);
    });
  });

  describe('hyperlane warp check --symbol ...', () => {
    it(`should not find any differences between the on chain config and the local one`, async function () {
      await deployAndExportWarpRoute();

      // only one route exists for this token so no need to interact with prompts
      const output = await hyperlaneWarpCheckRaw({
        symbol: tokenSymbol,
      })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    });
  });

  describe('hyperlane warp check --warpRouteId ...', () => {
    it(`should not find any differences between the on chain config and the local one`, async function () {
      await deployAndExportWarpRoute();

      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: createWarpRouteConfigId(tokenSymbol, [
          CHAIN_NAME_2,
          CHAIN_NAME_3,
        ]),
      })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    });
  });

  describe('hyperlane warp check --config ... --warp ...', () => {
    it(`should not find any differences between the on chain config and the local one`, async function () {
      await deployAndExportWarpRoute();

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      });

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

        const output = await hyperlaneWarpCheckRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
          warpCoreConfigPath: combinedWarpCoreConfigPath,
        });

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

        const output = await hyperlaneWarpCheckRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
          warpCoreConfigPath: combinedWarpCoreConfigPath,
        });

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
      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      })
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

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      }).nothrow();

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

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.includes(expectedDiffText);
      expect(output.text()).to.includes(expectedActualText);
    });

    describe('check extra lockboxes', () => {
      async function deployXERC20WarpRoute(): Promise<
        [string, WarpRouteDeployConfig]
      > {
        const xERC20TokenSymbol = 'XERC20TOKEN';
        const xERC20Token = await deployXERC20VSToken(
          ANVIL_KEY,
          CHAIN_NAME_2,
          undefined,
          xERC20TokenSymbol,
        );

        const token = await deployToken(
          ANVIL_KEY,
          CHAIN_NAME_2,
          undefined,
          'XERC20Collateral',
        );
        const xERC20Lockbox = await deployXERC20LockboxToken(
          ANVIL_KEY,
          CHAIN_NAME_2,
          token,
        );

        const tx = await xERC20Token.addBridge({
          bridge: xERC20Lockbox.address,
          bufferCap: '1000',
          rateLimitPerSecond: '1000',
        });

        await tx.wait();

        const warpConfig: WarpRouteDeployConfig = {
          [CHAIN_NAME_2]: {
            type: TokenType.XERC20,
            token: xERC20Token.address,
            mailbox: chain2Addresses.mailbox,
            owner: ownerAddress,
            xERC20: {
              warpRouteLimits: {
                bufferCap: '0',
                rateLimitPerSecond: '0',
              },
              extraBridges: [
                {
                  limits: {
                    bufferCap: '1000',
                    rateLimitPerSecond: '1000',
                  },
                  lockbox: xERC20Lockbox.address,
                },
              ],
            },
          },
        };

        writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
        await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

        return [xERC20TokenSymbol, warpConfig];
      }

      it(`should not find differences between the local limits and the on chain ones`, async function () {
        const output = await hyperlaneWarpCheckRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
          warpCoreConfigPath: combinedWarpCoreConfigPath,
        }).nothrow();

        expect(output.exitCode).to.equal(0);
      });

      it(`should find differences between the local limits and the on chain ones`, async function () {
        const [xERC20TokenSymbol, warpDeployConfig] =
          await deployXERC20WarpRoute();

        assert(
          warpDeployConfig[CHAIN_NAME_2].type === TokenType.XERC20,
          'Deploy config should be for an XERC20 token',
        );
        const currentExtraBridgesLimits =
          warpDeployConfig[CHAIN_NAME_2].xERC20!.extraBridges![0];
        const wrongBufferCap = randomInt(100).toString();
        warpDeployConfig[CHAIN_NAME_2].xERC20!.extraBridges = [
          {
            ...currentExtraBridgesLimits,
            limits: {
              bufferCap: wrongBufferCap,
              rateLimitPerSecond:
                currentExtraBridgesLimits.limits.rateLimitPerSecond,
            },
          },
        ];

        writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);
        const expectedDiffText = `EXPECTED: "${wrongBufferCap}"\n`;
        const expectedActualText = `ACTUAL: "${currentExtraBridgesLimits.limits.rateLimitPerSecond}"\n`;

        const output = await hyperlaneWarpCheckRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
          warpCoreConfigPath: getCombinedWarpRoutePath(xERC20TokenSymbol, [
            CHAIN_NAME_2,
          ]),
        }).nothrow();

        expect(output.exitCode).to.equal(1);
        expect(output.text()).includes(expectedDiffText);
        expect(output.text()).includes(expectedActualText);
      });
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

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      }).nothrow();
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

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text().includes(expectedDiffText)).to.be.true;
      expect(output.text().includes(expectedActualText)).to.be.true;
    });
  }
});
