import { expect } from 'chai';
import { type Signer, Wallet, ethers } from 'ethers';
import { zeroAddress } from 'viem';

import {
  type ERC20Test,
  InterchainAccountRouter__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  type AccountConfig,
  type ChainMetadata,
  HookType,
  InterchainAccount,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, addressToBytes32 } from '@hyperlane-xyz/utils';

import { getContext } from '../../../context/context.js';
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
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  WARP_DEPLOY_DEFAULT_FILE_NAME,
  WARP_DEPLOY_OUTPUT_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

describe('hyperlane warp check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let signer: Signer;
  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let chain4Addresses: ChainAddresses = {};
  let token: ERC20Test;
  let tokenSymbol: string;
  let ownerAddress: Address;
  let combinedWarpCoreConfigPath: string;
  let warpConfig: WarpRouteDeployConfig;

  before(async function () {
    [chain2Addresses, chain3Addresses, chain4Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_4, CORE_CONFIG_PATH, ANVIL_KEY),
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

  describe('hyperlane warp check --ica', () => {
    let expectedIcaAddress: Address;
    let icaOwnerAddress: Address;

    function createIcaWarpConfig(
      destinationOwner: Address,
    ): WarpRouteDeployConfig {
      return {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain2Addresses.mailbox,
          owner: icaOwnerAddress,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          owner: destinationOwner,
        },
      };
    }

    async function deployIcaWarpRoute(
      destinationOwner: Address,
      suffix: string,
    ): Promise<string> {
      const icaWarpConfig = createIcaWarpConfig(destinationOwner);
      const warpDeployPath = combinedWarpCoreConfigPath.replace(
        '-config.yaml',
        `-ica-${suffix}-deploy.yaml`,
      );
      writeYamlOrJson(warpDeployPath, icaWarpConfig);

      const currentWarpId = createWarpRouteConfigId(
        await token.symbol(),
        `${CHAIN_NAME_3}-ica-${suffix}`,
      );

      await hyperlaneWarpDeploy(warpDeployPath, currentWarpId);
      return currentWarpId;
    }

    before(async function () {
      icaOwnerAddress = new Wallet(ANVIL_KEY).address;
      const chain2Metadata: ChainMetadata = readYamlOrJson(
        CHAIN_2_METADATA_PATH,
      );
      const chain3Metadata: ChainMetadata = readYamlOrJson(
        CHAIN_3_METADATA_PATH,
      );

      const providerChain2 = new ethers.providers.JsonRpcProvider(
        chain2Metadata.rpcUrls[0].http,
      );
      const providerChain3 = new ethers.providers.JsonRpcProvider(
        chain3Metadata.rpcUrls[0].http,
      );

      const walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
      const walletChain3 = new Wallet(ANVIL_KEY).connect(providerChain3);

      const { registry, multiProvider } = await getContext({
        registryUris: [REGISTRY_PATH],
        key: ANVIL_KEY,
      });
      const freshChain2Addresses =
        await registry.getChainAddresses(CHAIN_NAME_2);
      const freshChain3Addresses =
        await registry.getChainAddresses(CHAIN_NAME_3);

      expect(
        freshChain2Addresses?.interchainAccountRouter,
        `Missing ICA router for ${CHAIN_NAME_2}. Got: ${JSON.stringify(freshChain2Addresses)}`,
      ).to.exist;
      expect(
        freshChain3Addresses?.interchainAccountRouter,
        `Missing ICA router for ${CHAIN_NAME_3}. Got: ${JSON.stringify(freshChain3Addresses)}`,
      ).to.exist;

      const icaRouterChain2 = InterchainAccountRouter__factory.connect(
        freshChain2Addresses!.interchainAccountRouter!,
        walletChain2,
      );
      const icaRouterChain3 = InterchainAccountRouter__factory.connect(
        freshChain3Addresses!.interchainAccountRouter!,
        walletChain3,
      );

      // Enroll routers (catch errors in case they're already enrolled from previous runs)
      try {
        await icaRouterChain3
          .enrollRemoteRouterAndIsm(
            chain2Metadata.domainId!,
            addressToBytes32(chain2Addresses.interchainAccountRouter!),
            ethers.constants.HashZero,
          )
          .then((tx) => tx.wait());
      } catch {
        // Already enrolled
      }

      try {
        await icaRouterChain2
          .enrollRemoteRouterAndIsm(
            chain3Metadata.domainId!,
            addressToBytes32(chain3Addresses.interchainAccountRouter!),
            ethers.constants.HashZero,
          )
          .then((tx) => tx.wait());
      } catch {
        // Already enrolled
      }

      const addressesMap: Record<string, Record<string, string>> = {
        [CHAIN_NAME_2]: freshChain2Addresses as Record<string, string>,
        [CHAIN_NAME_3]: freshChain3Addresses as Record<string, string>,
      };

      const ica = InterchainAccount.fromAddressesMap(
        addressesMap,
        multiProvider,
      );

      const ownerConfig: AccountConfig = {
        origin: CHAIN_NAME_2,
        owner: icaOwnerAddress,
      };

      expectedIcaAddress = await ica.getAccount(CHAIN_NAME_3, ownerConfig);
    });

    it('should pass when destination owner matches calculated ICA address', async function () {
      const currentWarpId = await deployIcaWarpRoute(expectedIcaAddress, 'ok');

      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: currentWarpId,
        ica: true,
        origin: CHAIN_NAME_2,
      }).nothrow();

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    });

    it('should fail when destination owner does not match calculated ICA address', async function () {
      const wrongOwner = '0x1234567890123456789012345678901234567890';
      const currentWarpId = await deployIcaWarpRoute(wrongOwner, 'wrong');

      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: currentWarpId,
        ica: true,
        origin: CHAIN_NAME_2,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.include('ACTUAL');
      expect(output.text()).to.include('EXPECTED');
      expect(output.text()).to.include(expectedIcaAddress.toLowerCase());
    });

    it('should fail when --ica is used without --origin', async function () {
      const currentWarpId = await deployIcaWarpRoute(
        expectedIcaAddress,
        'no-origin',
      );

      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: currentWarpId,
        ica: true,
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.include('--origin is required when using --ica');
    });

    it('should fail when --origin is not part of the warp config', async function () {
      const currentWarpId = await deployIcaWarpRoute(
        expectedIcaAddress,
        'invalid-origin',
      );

      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: currentWarpId,
        ica: true,
        origin: 'nonexistent',
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.include(
        'Origin chain "nonexistent" is not part of the warp config',
      );
    });

    it('should warn and skip when --destinations contains chains not in the warp config', async function () {
      const currentWarpId = await deployIcaWarpRoute(
        expectedIcaAddress,
        'invalid-dest',
      );

      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: currentWarpId,
        ica: true,
        origin: CHAIN_NAME_2,
        destinations: ['nonexistent'],
      }).nothrow();

      expect(output.exitCode).to.equal(1);
      expect(output.text()).to.include('not part of the warp config');
      expect(output.text()).to.include('No EVM destination chains to check');
    });

    it('should only check specified destinations when --destinations is provided', async function () {
      const currentWarpId = await deployIcaWarpRoute(
        expectedIcaAddress,
        'filter-dest',
      );

      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: currentWarpId,
        ica: true,
        origin: CHAIN_NAME_2,
        destinations: [CHAIN_NAME_3],
      }).nothrow();

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    });

    it('should only check ICA ownership on specified destinations when using --destinations with mixed ICA/EOA owners', async function () {
      // Create 3-chain warp config with mixed ownership:
      // - anvil2 (origin): ICA owner
      // - anvil3: correct ICA address (should pass)
      // - anvil4: wrong EOA owner (would fail if checked)
      const wrongOwner = '0x1234567890123456789012345678901234567890';
      const mixedOwnerConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: token.address,
          mailbox: chain2Addresses.mailbox,
          owner: icaOwnerAddress,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.synthetic,
          mailbox: chain3Addresses.mailbox,
          owner: expectedIcaAddress,
        },
        [CHAIN_NAME_4]: {
          type: TokenType.synthetic,
          mailbox: chain4Addresses.mailbox,
          owner: wrongOwner,
        },
      };

      // Deploy the 3-chain warp route
      const symbol = await token.symbol();
      const configPath = `${CHAIN_NAME_3}-${CHAIN_NAME_4}-ica-mixed`;
      const currentWarpId = createWarpRouteConfigId(symbol, configPath);

      // Write deploy config to path matching the warpRouteId
      const warpDeployPath = getCombinedWarpRoutePath(symbol, [
        configPath,
      ]).replace('-config.yaml', '-deploy.yaml');
      writeYamlOrJson(warpDeployPath, mixedOwnerConfig);

      await hyperlaneWarpDeploy(warpDeployPath, currentWarpId);

      // Run check with --destinations to only check anvil3 (ICA), skipping anvil4 (EOA)
      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: currentWarpId,
        ica: true,
        origin: CHAIN_NAME_2,
        destinations: [CHAIN_NAME_3],
      }).nothrow();

      // Should pass because we only checked anvil3 which has correct ICA owner
      // anvil4 with wrong owner was skipped
      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    });
  });
});
