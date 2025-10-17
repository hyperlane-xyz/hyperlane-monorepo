import { expect } from 'chai';
import { Wallet } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  HypTokenRouterConfig,
  TokenType,
  WarpRouteDeployConfig,
  normalizeConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, addressToBytes32 } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
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
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';
import { getDomainId } from '../commands/helpers.js';

describe('hyperlane warp apply config extension tests', async function () {
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

  it('should update destination gas configuration', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

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

    // First read the existing config
    const updatedWarpConfig = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      DEFAULT_EVM_WARP_CORE_PATH,
    );

    // Get the domain ID for chain 3
    const chain3Id = await getDomainId(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );

    // Update with new destination gas values
    updatedWarpConfig[
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
    ].destinationGas = {
      [chain3Id]: '500000', // Set a specific gas value for chain 3
    };

    // Write the updated config
    await writeYamlOrJson(warpDeployPath, updatedWarpConfig);

    // Apply the changes
    await evmWarpCommands.applyRaw({
      warpDeployPath,
      warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
      warpRouteId: DEFAULT_EVM_WARP_ID,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      skipConfirmationPrompts: true,
    });

    // Read back the config to verify changes
    const updatedConfig = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      DEFAULT_EVM_WARP_CORE_PATH,
    );

    // Verify the destination gas was updated correctly
    expect(
      updatedConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
        .destinationGas![chain3Id],
    ).to.equal('500000');
  });

  it('should update remote routers configuration', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

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

    // First read the existing config
    const updatedWarpDeployConfig = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      DEFAULT_EVM_WARP_CORE_PATH,
    );

    // Get the domain ID for chain 3
    const chain3Id = await getDomainId(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
      HYP_KEY_BY_PROTOCOL.ethereum,
    );

    // Generate a new router address to update
    const newRouterAddress = randomAddress();

    // Update with new remote router values
    updatedWarpDeployConfig[
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
    ].remoteRouters = {
      [chain3Id]: { address: newRouterAddress }, // Set a new router address for chain 3
    };

    // Write the updated config
    await writeYamlOrJson(warpDeployPath, updatedWarpDeployConfig);

    // Apply the changes
    await evmWarpCommands.applyRaw({
      warpDeployPath,
      warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
      warpRouteId: DEFAULT_EVM_WARP_ID,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      skipConfirmationPrompts: true,
    });

    // Read back the config to verify changes
    const updatedConfig = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      DEFAULT_EVM_WARP_CORE_PATH,
    );

    // Verify the remote router was updated correctly
    expect(
      updatedConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].remoteRouters![chain3Id].address.toLowerCase(),
    ).to.equal(addressToBytes32(newRouterAddress));
  });

  it('should preserve deploy config when extending warp route', async () => {
    const warpDeployPath = `${TEMP_PATH}/warp-route-deployment-2.yaml`;

    // Extend with new config for chain 3
    const extendedConfig: HypTokenRouterConfig = {
      decimals: 18,
      mailbox: chain3Addresses!.mailbox,
      name: 'Ether',
      owner: new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address,
      symbol: 'ETH',
      type: TokenType.native,
    };

    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3] =
      extendedConfig;
    await writeYamlOrJson(warpDeployPath, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpDeployPath,
      warpCorePath: DEFAULT_EVM_WARP_CORE_PATH,
      warpRouteId: DEFAULT_EVM_WARP_ID,
      privateKey: HYP_KEY_BY_PROTOCOL.ethereum,
      skipConfirmationPrompts: true,
    });

    const updatedConfig: WarpRouteDeployConfig = readYamlOrJson(warpDeployPath);

    expect(normalizeConfig(warpDeployConfig)).to.deep.equal(
      normalizeConfig(updatedConfig),
      'warp deploy config should remain unchanged after extension',
    );
  });
});
