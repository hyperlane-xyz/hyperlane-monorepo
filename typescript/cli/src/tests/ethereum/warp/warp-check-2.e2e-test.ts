import { expect } from 'chai';
import { Signer, Wallet, ethers } from 'ethers';
import { zeroAddress } from 'viem';

import { ERC20Test, HypERC20Collateral__factory } from '@hyperlane-xyz/core';
import {
  ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  TokenStandard,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { deployToken } from '../commands/helpers.js';
import {
  hyperlaneWarpCheckRaw,
  hyperlaneWarpDeploy,
} from '../commands/warp.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  WARP_DEPLOY_OUTPUT_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

describe('hyperlane warp check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let signer: Signer;
  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let chain3DomainId: number;
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
    chain3DomainId = (readYamlOrJson(CHAIN_3_METADATA_PATH) as ChainMetadata)
      .domainId;

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
        warpRouteId: createWarpRouteConfigId(tokenSymbol, CHAIN_NAME_3),
      })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    });

    it(`should successfully check warp routes that are not deployed as proxies`, async () => {
      // Deploy the token and the hyp adapter
      const symbol = 'NTAP';
      const tokenName = 'NOTAPROXY';
      const tokenDecimals = 10;
      const collateral = await deployToken(
        ANVIL_KEY,
        CHAIN_NAME_2,
        tokenDecimals,
        symbol,
      );

      const contract = new HypERC20Collateral__factory(signer);
      const tx = await contract.deploy(
        collateral.address,
        1,
        chain2Addresses.mailbox,
      );

      const deployedContract = await tx.deployed();
      const tx2 = await deployedContract.initialize(
        zeroAddress,
        zeroAddress,
        ANVIL_DEPLOYER_ADDRESS,
      );

      await tx2.wait();

      // Manually add config files to the registry
      const routePath = getCombinedWarpRoutePath(symbol, [CHAIN_NAME_2]);
      const warpDeployConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: collateral.address,
          owner: ANVIL_DEPLOYER_ADDRESS,
        },
      };
      writeYamlOrJson(
        routePath.replace('-config.yaml', '-deploy.yaml'),
        warpDeployConfig,
      );

      const warpCoreConfig: WarpCoreConfig = {
        tokens: [
          {
            addressOrDenom: deployedContract.address,
            chainName: CHAIN_NAME_2,
            decimals: tokenDecimals,
            collateralAddressOrDenom: token.address,
            name: tokenName,
            standard: TokenStandard.EvmHypCollateral,
            symbol,
          },
        ],
      };
      writeYamlOrJson(routePath, warpCoreConfig);

      // Finally run warp check
      const output = await hyperlaneWarpCheckRaw({
        warpRouteId: createWarpRouteConfigId(symbol, CHAIN_NAME_2),
      })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    });
  });

  it('should successfully check allowedRebalancers', async () => {
    assert(
      warpConfig[CHAIN_NAME_2].type === TokenType.collateral,
      'Expected config to be for a collateral token',
    );
    warpConfig[CHAIN_NAME_2].allowedRebalancers = [randomAddress()];
    await deployAndExportWarpRoute();

    const output = await hyperlaneWarpCheckRaw({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpCoreConfigPath: combinedWarpCoreConfigPath,
    })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(0);
    expect(output.text()).to.include('No violations found');
  });

  it('should report a violation if no rebalancers are in the config but are set on chain', async () => {
    assert(
      warpConfig[CHAIN_NAME_2].type === TokenType.collateral,
      'Expected config to be for a collateral token',
    );
    warpConfig[CHAIN_NAME_2].allowedRebalancers = [randomAddress()];
    await deployAndExportWarpRoute();

    warpConfig[CHAIN_NAME_2].allowedRebalancers = undefined;
    const wrongDeployConfigPath = combinedWarpCoreConfigPath.replace(
      '-config.yaml',
      '-deploy.yaml',
    );
    writeYamlOrJson(wrongDeployConfigPath, warpConfig);

    const output = await hyperlaneWarpCheckRaw({
      warpDeployPath: wrongDeployConfigPath,
      warpCoreConfigPath: combinedWarpCoreConfigPath,
    })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(1);
  });

  it('should successfully check the allowed rebalancing bridges', async () => {
    assert(
      warpConfig[CHAIN_NAME_2].type === TokenType.collateral,
      'Expected config to be for a collateral token',
    );
    warpConfig[CHAIN_NAME_2].allowedRebalancingBridges = {
      [chain3DomainId]: [{ bridge: randomAddress() }],
    };
    await deployAndExportWarpRoute();

    const output = await hyperlaneWarpCheckRaw({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpCoreConfigPath: combinedWarpCoreConfigPath,
    })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(0);
    expect(output.text()).to.include('No violations found');
  });

  it('should report a violation if no allowed bridges are in the config but are set on chain', async () => {
    assert(
      warpConfig[CHAIN_NAME_2].type === TokenType.collateral,
      'Expected config to be for a collateral token',
    );
    warpConfig[CHAIN_NAME_2].allowedRebalancingBridges = {
      [chain3DomainId]: [{ bridge: randomAddress() }],
    };
    await deployAndExportWarpRoute();

    warpConfig[CHAIN_NAME_2].allowedRebalancingBridges = undefined;
    const wrongDeployConfigPath = combinedWarpCoreConfigPath.replace(
      '-config.yaml',
      '-deploy.yaml',
    );
    writeYamlOrJson(wrongDeployConfigPath, warpConfig);

    const output = await hyperlaneWarpCheckRaw({
      warpDeployPath: wrongDeployConfigPath,
      warpCoreConfigPath: combinedWarpCoreConfigPath,
    })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(1);
  });
});
