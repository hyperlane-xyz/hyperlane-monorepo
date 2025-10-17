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
import { Address, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_PATH_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  WARP_DEPLOY_OUTPUT_PATH,
  getWarpCoreConfigPath,
} from '../../constants.js';
import { deployToken } from '../commands/helpers.js';

describe('hyperlane warp check e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let signer: Signer;
  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let chain3DomainId: number;
  let token: ERC20Test;
  let tokenSymbol: string;
  let ownerAddress: Address;
  let deployerAddress: Address;
  let combinedWarpCoreConfigPath: string;
  let warpConfig: WarpRouteDeployConfig;

  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );
  const evmChain3Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    WARP_DEPLOY_OUTPUT_PATH,
  );

  before(async function () {
    [chain2Addresses, chain3Addresses, deployerAddress] = await Promise.all([
      evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      evmChain3Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum(),
    ]);

    const chainMetadata: ChainMetadata = readYamlOrJson(
      TEST_CHAIN_METADATA_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    );
    chain3DomainId = (
      readYamlOrJson(
        TEST_CHAIN_METADATA_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      ) as ChainMetadata
    ).domainId;

    const provider = new ethers.providers.JsonRpcProvider(
      chainMetadata.rpcUrls[0].http,
    );

    signer = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).connect(provider);

    token = await deployToken(
      HYP_KEY_BY_PROTOCOL.ethereum,
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    );
    tokenSymbol = await token.symbol();

    combinedWarpCoreConfigPath = getWarpCoreConfigPath(tokenSymbol, [
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
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
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    );

    await evmWarpCommands.deploy(
      WARP_DEPLOY_OUTPUT_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
      currentWarpId,
    );

    return warpConfig;
  }

  // Reset config before each test to avoid test changes intertwining
  beforeEach(async function () {
    ownerAddress = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address;
    warpConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: token.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
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

      const output1 = await evmWarpCommands
        .checkRaw({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        })
        .stdio('pipe')
        .nothrow();

      const output2 = await evmWarpCommands
        .checkRaw({
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
      const output = await evmWarpCommands
        .checkRaw({
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

      const output = await evmWarpCommands
        .checkRaw({
          warpRouteId: createWarpRouteConfigId(
            tokenSymbol,
            TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
          ),
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
        HYP_KEY_BY_PROTOCOL.ethereum,
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
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
        deployerAddress,
      );

      await tx2.wait();

      // Manually add config files to the registry
      const routePath = getWarpCoreConfigPath(symbol, [
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      ]);
      const warpDeployConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: collateral.address,
          owner: deployerAddress,
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
            chainName: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
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
      const output = await evmWarpCommands
        .checkRaw({
          warpRouteId: createWarpRouteConfigId(
            symbol,
            TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          ),
        })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    });
  });

  it('should successfully check allowedRebalancers', async () => {
    const chain2DeployConfig =
      warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2];
    assert(
      chain2DeployConfig.type === TokenType.collateral,
      'Expected config to be for a collateral token',
    );
    chain2DeployConfig.allowedRebalancers = [randomAddress()];
    await deployAndExportWarpRoute();

    const output = await evmWarpCommands
      .checkRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(0);
    expect(output.text()).to.include('No violations found');
  });

  it('should report a violation if no rebalancers are in the config but are set on chain', async () => {
    const chain2DeployConfig =
      warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2];
    assert(
      chain2DeployConfig.type === TokenType.collateral,
      'Expected config to be for a collateral token',
    );
    chain2DeployConfig.allowedRebalancers = [randomAddress()];
    await deployAndExportWarpRoute();

    chain2DeployConfig.allowedRebalancers = undefined;
    const wrongDeployConfigPath = combinedWarpCoreConfigPath.replace(
      '-config.yaml',
      '-deploy.yaml',
    );
    writeYamlOrJson(wrongDeployConfigPath, warpConfig);

    const output = await evmWarpCommands
      .checkRaw({
        warpDeployPath: wrongDeployConfigPath,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(1);
  });

  it('should successfully check the allowed rebalancing bridges', async () => {
    const chain2DeployConfig =
      warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2];
    assert(
      chain2DeployConfig.type === TokenType.collateral,
      'Expected config to be for a collateral token',
    );
    chain2DeployConfig.allowedRebalancingBridges = {
      [chain3DomainId]: [{ bridge: randomAddress() }],
    };
    await deployAndExportWarpRoute();

    const output = await evmWarpCommands
      .checkRaw({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(0);
    expect(output.text()).to.include('No violations found');
  });

  it('should report a violation if no allowed bridges are in the config but are set on chain', async () => {
    const chain2DeployConfig =
      warpConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2];
    assert(
      chain2DeployConfig.type === TokenType.collateral,
      'Expected config to be for a collateral token',
    );
    chain2DeployConfig.allowedRebalancingBridges = {
      [chain3DomainId]: [{ bridge: randomAddress() }],
    };
    await deployAndExportWarpRoute();

    chain2DeployConfig.allowedRebalancingBridges = undefined;
    const wrongDeployConfigPath = combinedWarpCoreConfigPath.replace(
      '-config.yaml',
      '-deploy.yaml',
    );
    writeYamlOrJson(wrongDeployConfigPath, warpConfig);

    const output = await evmWarpCommands
      .checkRaw({
        warpDeployPath: wrongDeployConfigPath,
        warpCoreConfigPath: combinedWarpCoreConfigPath,
      })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(1);
  });
});
