import { expect } from 'chai';
import { Signer, Wallet, ethers } from 'ethers';
import { zeroAddress } from 'viem';

import { ERC20Test, Mailbox__factory } from '@hyperlane-xyz/core';
import {
  ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  HookType,
  IsmType,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address, addressToBytes32 } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { deployToken } from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpCheckRaw,
  hyperlaneWarpDeploy,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  WARP_DEPLOY_DEFAULT_FILE_NAME,
  WARP_DEPLOY_OUTPUT_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

describe('hyperlane warp check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let signer: Signer;
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

    const chainMetadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);

    const provider = new ethers.providers.JsonRpcProvider(
      chainMetadata.rpcUrls[0].http,
    );

    signer = new Wallet(ANVIL_KEY).connect(provider);

    token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    tokenSymbol = await token.symbol();

    combinedWarpCoreConfigPath = getCombinedWarpRoutePath(tokenSymbol, [
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

    const currentWarpId = createWarpRouteConfigId(
      await token.symbol(),
      CHAIN_NAME_3,
    );

    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, currentWarpId);

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

      // Find the token for CHAIN_NAME_2 since we're unenrolling it from CHAIN 3
      const chain2Token = warpCore.tokens.find(
        (token) => token.chainName === CHAIN_NAME_2,
      );
      expect(chain2Token).to.not.be.undefined;

      const expectedActualText = `ACTUAL: ""\n`;
      const expectedDiffTextRegex = new RegExp(
        `EXPECTED:\\s*address:\\s*"${addressToBytes32(chain2Token!.addressOrDenom!)}"`,
      );

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.match(expectedDiffTextRegex);
      expect(output.text()).to.includes(expectedActualText);
    });

    it(`should find differences in the hook config between the local and on chain config if it needs to be expanded`, async function () {
      warpConfig[CHAIN_NAME_2].hook = {
        type: HookType.MERKLE_TREE,
      };

      const mailboxInstance = Mailbox__factory.connect(
        chain2Addresses.mailbox,
        signer,
      );
      const hookAddress = await mailboxInstance.callStatic.defaultHook();

      const warpDeployPath = combinedWarpCoreConfigPath.replace(
        '-config.yaml',
        '-deploy.yaml',
      );
      writeYamlOrJson(warpDeployPath, warpConfig);
      writeYamlOrJson(warpDeployPath, warpConfig);

      const currentWarpId = createWarpRouteConfigId(
        await token.symbol(),
        CHAIN_NAME_3,
      );

      const warpDeployConfig = warpConfig;
      await hyperlaneWarpDeploy(warpDeployPath, currentWarpId);

      const expectedOwner = (await signer.getAddress()).toLowerCase();
      warpDeployConfig[CHAIN_NAME_2].hook = {
        type: HookType.FALLBACK_ROUTING,
        domains: {},
        fallback: hookAddress,
        owner: expectedOwner,
      };

      writeYamlOrJson(warpDeployPath, warpDeployConfig);

      const expectedActualText = `ACTUAL: ${HookType.MERKLE_TREE}\n`;
      const expectedDiffText = `EXPECTED: ${HookType.FALLBACK_ROUTING}`;

      const expectedFallbackDiff = `    fallback:
      ACTUAL: ""
      EXPECTED:
        owner: "${expectedOwner}"
        type: protocolFee
        maxProtocolFee: "1000000000000000000"
        protocolFee: "200000000000000"
        beneficiary: "${expectedOwner}"`;

      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: currentWarpId,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.includes(expectedDiffText);
      expect(output.text()).to.includes(expectedActualText);
      expect(output.text()).to.includes(expectedFallbackDiff);
    });

    it(`should find differences in the hook config between the local and on chain config if it compares the hook addresses`, async function () {
      const mailboxInstance = Mailbox__factory.connect(
        chain2Addresses.mailbox,
        signer,
      );
      const hookAddress = (
        await mailboxInstance.callStatic.defaultHook()
      ).toLowerCase();

      const warpDeployConfig = await deployAndExportWarpRoute();
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      warpDeployConfig[CHAIN_NAME_2].hook = hookAddress;
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);

      const expectedActualText = `ACTUAL: "${zeroAddress}"\n`;
      const expectedDiffText = `EXPECTED: "${hookAddress}"`;

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.includes(expectedDiffText);
      expect(output.text()).to.includes(expectedActualText);
    });

    it(`should find inconsistent decimals without scale`, async function () {
      const WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath(
        await token.symbol(),
        [WARP_DEPLOY_DEFAULT_FILE_NAME],
      );

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      const deployConfig: WarpRouteDeployConfig = readYamlOrJson(
        WARP_DEPLOY_OUTPUT_PATH,
      );

      deployConfig[CHAIN_NAME_2].decimals = 6;
      deployConfig[CHAIN_NAME_3].decimals = 18;

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, deployConfig);

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: WARP_CORE_CONFIG_PATH,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.includes(
        `Found invalid or missing scale for inconsistent decimals`,
      );
    });

    it(`should find invalid scale config`, async function () {
      const WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath(
        await token.symbol(),
        [WARP_DEPLOY_DEFAULT_FILE_NAME],
      );

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
      await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH);

      const deployConfig: WarpRouteDeployConfig = readYamlOrJson(
        WARP_DEPLOY_OUTPUT_PATH,
      );

      deployConfig[CHAIN_NAME_2].decimals = 6;
      deployConfig[CHAIN_NAME_2].scale = 1;

      deployConfig[CHAIN_NAME_3].decimals = 34;
      deployConfig[CHAIN_NAME_2].scale = 2;

      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, deployConfig);

      const output = await hyperlaneWarpCheckRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: WARP_CORE_CONFIG_PATH,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.includes(
        `Found invalid or missing scale for inconsistent decimals`,
      );
    });
  });
});
