import { expect } from 'chai';
import { type Signer, Wallet, ethers } from 'ethers';
import { zeroAddress } from 'viem';

import { type ERC20Test, Mailbox__factory } from '@hyperlane-xyz/core';
import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  type ChainMetadata,
  HookType,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { deployToken } from '../commands/helpers.js';
import {
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

  describe('--chains filtering', () => {
    it('should only check specified chains and skip violations on other chains', async function () {
      // Deploy warp route with merkle tree hook on chain2
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

      const currentWarpId = createWarpRouteConfigId(
        await token.symbol(),
        CHAIN_NAME_3,
      );
      await hyperlaneWarpDeploy(warpDeployPath, currentWarpId);

      // Introduce a violation on chain2's hook config (change from merkle tree to fallback routing)
      const expectedOwner = (await signer.getAddress()).toLowerCase();
      warpConfig[CHAIN_NAME_2].hook = {
        type: HookType.FALLBACK_ROUTING,
        domains: {},
        fallback: hookAddress,
        owner: expectedOwner,
      };
      writeYamlOrJson(warpDeployPath, warpConfig);

      // Check only chain3 - should find no violations since chain2's violation is filtered out
      const chain3Output = await hyperlaneWarpCheckRaw({
        warpDeployPath,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
        chains: [CHAIN_NAME_3],
      }).nothrow();

      expect(chain3Output.exitCode).to.equal(0);
      expect(chain3Output.text()).to.include('No violations found');

      // Check only chain2 - should find violations since chain2 has a hook mismatch
      const chain2Output = await hyperlaneWarpCheckRaw({
        warpDeployPath,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
        chains: [CHAIN_NAME_2],
      }).nothrow();

      expect(chain2Output.exitCode).to.equal(1);
      expect(chain2Output.text()).to.include(HookType.FALLBACK_ROUTING);
    });

    it('should warn about unknown chains but continue', async function () {
      await deployAndExportWarpRoute();
      const currentWarpId = createWarpRouteConfigId(
        await token.symbol(),
        CHAIN_NAME_3,
      );

      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: currentWarpId,
        chains: [CHAIN_NAME_2, 'unknown-chain'],
      }).nothrow();

      expect(output.text()).to.include(
        'Chain "unknown-chain" is not part of the warp config, skipping',
      );
      // Should still check anvil2 and complete
      expect(output.exitCode).to.be.oneOf([0, 1]);
    });

    it('should warn when all chains are unknown', async function () {
      await deployAndExportWarpRoute();
      const currentWarpId = createWarpRouteConfigId(
        await token.symbol(),
        CHAIN_NAME_3,
      );

      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: currentWarpId,
        chains: ['unknown1', 'unknown2'],
      }).nothrow();

      // Should warn about each unknown chain
      expect(output.text()).to.include(
        'Chain "unknown1" is not part of the warp config, skipping',
      );
      expect(output.text()).to.include(
        'Chain "unknown2" is not part of the warp config, skipping',
      );
    });
  });
});
