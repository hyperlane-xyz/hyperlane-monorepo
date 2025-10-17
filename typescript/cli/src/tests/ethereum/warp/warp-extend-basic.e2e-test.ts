import { expect } from 'chai';
import { Wallet } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  HypTokenRouterConfig,
  TokenType,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  DEFAULT_EVM_WARP_CORE_PATH,
  DEFAULT_EVM_WARP_DEPLOY_PATH,
  DEFAULT_EVM_WARP_ID,
  DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  DEPLOYER_ADDRESS_BY_PROTOCOL,
  E2E_BURN_ADDRESS_BY_PROTOCOL,
  EXAMPLES_PATH,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  getWarpCoreConfigPath,
} from '../../constants.js';
import { getDomainId } from '../commands/helpers.js';

describe('hyperlane warp apply basic extension tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain3Addresses: ChainAddresses = {};

  let ownerAddress: Address;
  let warpDeployConfig: WarpRouteDeployConfig;

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
    DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  );

  before(async function () {
    [, chain3Addresses] = await Promise.all([
      evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      evmChain3Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);

    ownerAddress = await DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum();
  });

  beforeEach(async function () {
    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.native,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);
    await evmWarpCommands.deploy(
      DEFAULT_EVM_WARP_DEPLOY_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );
  });

  it('should extend an existing warp route', async () => {
    // Extend with new config
    const config: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain3Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address,
      symbol: 'ETH',
      type: TokenType.native,
    };

    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3] =
      config;
    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpDeployPath: DEFAULT_EVM_WARP_DEPLOY_PATH,
      warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      skipConfirmationPrompts: true,
    });

    const COMBINED_WARP_CORE_CONFIG_PATH = getWarpCoreConfigPath('ETH', [
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    ]);

    // Check that chain2 is enrolled in chain1
    const updatedWarpDeployConfig1 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
    );

    const chain2Id = await getDomainId(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );
    const remoteRouterKeys1 = Object.keys(
      updatedWarpDeployConfig1[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].remoteRouters!,
    );
    expect(remoteRouterKeys1).to.include(chain2Id);

    // Check that chain1 is enrolled in chain2
    const updatedWarpDeployConfig2 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
    );

    const chain1Id = await getDomainId(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );
    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig2[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(chain1Id);
  });

  it('should extend an existing warp route with json strategy', async () => {
    // Extend with new config
    const config: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain3Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address,
      symbol: 'ETH',
      type: TokenType.native,
    };

    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3] =
      config;
    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpDeployPath: DEFAULT_EVM_WARP_DEPLOY_PATH,
      warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      skipConfirmationPrompts: true,
      strategyUrl: `${EXAMPLES_PATH}/submit/strategy/json-rpc-chain-strategy.yaml`,
    });

    const COMBINED_WARP_CORE_CONFIG_PATH = getWarpCoreConfigPath('ETH', [
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    ]);

    // Check that chain2 is enrolled in chain1
    const updatedWarpDeployConfig1 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      COMBINED_WARP_CORE_CONFIG_PATH,
    );

    const chain2Id = await getDomainId(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );
    const remoteRouterKeys1 = Object.keys(
      updatedWarpDeployConfig1[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].remoteRouters!,
    );
    expect(remoteRouterKeys1).to.include(chain2Id);

    // Check that chain1 is enrolled in chain2
    const updatedWarpDeployConfig2 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      COMBINED_WARP_CORE_CONFIG_PATH,
    );

    const chain1Id = await getDomainId(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );
    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig2[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(chain1Id);
  });

  it('should extend an existing warp route and update the owner', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].owner =
      E2E_BURN_ADDRESS_BY_PROTOCOL.ethereum;

    // Extend with new config
    const randomOwner = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address;
    const extendedConfig: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain3Addresses!.mailbox,
      name: 'Ether',
      owner: randomOwner,
      symbol: 'ETH',
      type: TokenType.native,
    };
    // Remove remoteRouters and destinationGas as they are written in readWarpConfig
    warpDeployConfig[
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
    ].remoteRouters = undefined;
    warpDeployConfig[
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
    ].destinationGas = undefined;

    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3] =
      extendedConfig;
    writeYamlOrJson(warpDeployPath, warpDeployConfig);
    await evmWarpCommands.applyRaw({
      warpDeployPath,
      warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
      warpRouteId: DEFAULT_EVM_WARP_ID,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      skipConfirmationPrompts: true,
    });

    const updatedWarpDeployConfig_2 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      DEFAULT_EVM_WARP_CORE_PATH,
    );
    const updatedWarpDeployConfig_3 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      DEFAULT_EVM_WARP_CORE_PATH,
    );
    // Check that anvil2 owner is burned
    expect(updatedWarpDeployConfig_2.anvil2.owner).to.equal(
      E2E_BURN_ADDRESS_BY_PROTOCOL.ethereum,
    );

    // Also, anvil3 owner is not burned
    expect(updatedWarpDeployConfig_3.anvil3.owner).to.equal(randomOwner);

    // Check that both chains enrolled
    const chain2Id = await getDomainId(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );
    const chain3Id = await getDomainId(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );

    const remoteRouterKeys2 = Object.keys(
      updatedWarpDeployConfig_2[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].remoteRouters!,
    );
    const remoteRouterKeys3 = Object.keys(
      updatedWarpDeployConfig_3[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].remoteRouters!,
    );
    expect(remoteRouterKeys2).to.include(chain3Id);
    expect(remoteRouterKeys3).to.include(chain2Id);
  });

  it('should extend an existing warp route and update all destination domains', async () => {
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].gas =
      7777;

    // Extend with new config
    const GAS = 694200;
    const extendedConfig: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain3Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address,
      symbol: 'ETH',
      type: TokenType.native,
      gas: GAS,
    };

    // Remove remoteRouters and destinationGas as they are written in readWarpConfig
    warpDeployConfig[
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
    ].remoteRouters = undefined;
    warpDeployConfig[
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
    ].destinationGas = undefined;

    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3] =
      extendedConfig;
    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);
    await evmWarpCommands.applyRaw({
      warpDeployPath: DEFAULT_EVM_WARP_DEPLOY_PATH,
      warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
      warpRouteId: DEFAULT_EVM_WARP_ID,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      skipConfirmationPrompts: true,
    });

    // Check that chain2 is enrolled in chain1
    const updatedWarpDeployConfig_2 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      DEFAULT_EVM_WARP_CORE_PATH,
    );

    const chain2Id = await getDomainId(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );
    const chain3Id = await getDomainId(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );

    // Destination gas should be set in the existing chain (chain2) to include the extended chain (chain3)
    const destinationGas_2 =
      updatedWarpDeployConfig_2[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].destinationGas!;
    expect(Object.keys(destinationGas_2)).to.include(chain3Id);
    expect(destinationGas_2[chain3Id]).to.equal(GAS.toString());

    // Destination gas should be set for the extended chain (chain3)
    const updatedWarpDeployConfig_3 = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      DEFAULT_EVM_WARP_CORE_PATH,
    );
    const destinationGas_3 =
      updatedWarpDeployConfig_3[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].destinationGas!;
    expect(Object.keys(destinationGas_3)).to.include(chain2Id);
    expect(destinationGas_3[chain2Id]).to.equal('7777');
  });
});
