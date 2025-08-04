import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  DerivedWarpRouteDeployConfig,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
  randomAddress,
  randomStarknetAddress,
  randomSvmAddress,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, addressToBytes32 } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_ADDRESSES_PATH_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  TEST_TOKEN_SYMBOL,
  UNSUPPORTED_CHAIN_CORE_ADDRESSES,
  WARP_READ_OUTPUT_PATH,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
  getWarpId,
} from '../../constants.js';
import { runCosmosNode, runEvmNode } from '../../nodes.js';
import { assertWarpRouteConfig } from '../../utils.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

describe('hyperlane warp deploy e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let cosmosNativeDeployerAddress: Address;
  let cosmosNativeChain1CoreAddress: ChainAddresses;
  const cosmosNativeChain1Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.cosmosnative,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
  );

  let evmDeployerAddress: Address;
  let evmChain1CoreCoreAddress: ChainAddresses;
  const evmChain1Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const WARP_CORE_PATH = getWarpCoreConfigPath(TEST_TOKEN_SYMBOL, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
  ]);
  const WARP_DEPLOY_PATH = getWarpDeployConfigPath(TEST_TOKEN_SYMBOL, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
  ]);
  const WARP_ROUTE_ID = getWarpId(TEST_TOKEN_SYMBOL, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
  ]);

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.CosmosNative,
    REGISTRY_PATH,
    WARP_CORE_PATH,
  );

  let coreAddressByChain: ChainMap<ChainAddresses>;

  before(async function () {
    await runCosmosNode(
      TEST_CHAIN_METADATA_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
    );
    await runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2);

    const cosmosWallet = await DirectSecp256k1Wallet.fromKey(
      Buffer.from(HYP_KEY_BY_PROTOCOL.cosmosnative, 'hex'),
      TEST_CHAIN_METADATA_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1.bech32Prefix,
    );
    [{ address: cosmosNativeDeployerAddress }] =
      await cosmosWallet.getAccounts();

    evmDeployerAddress = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address;

    [cosmosNativeChain1CoreAddress, evmChain1CoreCoreAddress] =
      await Promise.all([
        cosmosNativeChain1Core.deployOrUseExistingCore(
          HYP_KEY_BY_PROTOCOL.cosmosnative,
        ),
        evmChain1Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      ]);

    writeYamlOrJson(
      CORE_ADDRESSES_PATH_BY_PROTOCOL.sealevel.UNSUPPORTED_CHAIN,
      UNSUPPORTED_CHAIN_CORE_ADDRESSES,
    );

    coreAddressByChain = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1]:
        cosmosNativeChain1CoreAddress,
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]:
        evmChain1CoreCoreAddress,
    };
  });

  let warpDeployConfig: WarpRouteDeployConfig;
  beforeEach(() => {
    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1]: {
        type: TokenType.collateral,
        token: 'uhyp',
        mailbox: cosmosNativeChain1CoreAddress.mailbox,
        owner: cosmosNativeDeployerAddress,
        name: TEST_TOKEN_SYMBOL,
        symbol: TEST_TOKEN_SYMBOL,
        decimals: 6,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.synthetic,
        mailbox: evmChain1CoreCoreAddress.mailbox,
        owner: evmDeployerAddress,
        name: TEST_TOKEN_SYMBOL,
        symbol: TEST_TOKEN_SYMBOL,
        decimals: 6,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);
  });

  it('should successfully deploy on multiple supported chains of different protocol types', async () => {
    const output = await hyperlaneWarp
      .deployRaw({
        warpRouteId: WARP_ROUTE_ID,
        skipConfirmationPrompts: true,
        extraArgs: [
          `--key.${ProtocolType.Ethereum}`,
          HYP_KEY_BY_PROTOCOL.ethereum,
          `--key.${ProtocolType.CosmosNative}`,
          HYP_KEY_BY_PROTOCOL.cosmosnative,
        ],
      })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.eql(0);

    await hyperlaneWarp.readRaw({
      warpRouteId: WARP_ROUTE_ID,
      outputPath: WARP_READ_OUTPUT_PATH,
    });

    const config: DerivedWarpRouteDeployConfig = readYamlOrJson(
      WARP_READ_OUTPUT_PATH,
    );

    for (const chainName of Object.keys(warpDeployConfig)) {
      assertWarpRouteConfig(
        warpDeployConfig,
        config,
        coreAddressByChain,
        chainName,
      );
    }
  });

  const unsupportedChainsTestCases: Record<
    // Radix/sovereign is excluded because it is still not supported on main
    Exclude<ProtocolType, ProtocolType.Radix | ProtocolType.Sovereign>,
    Address
  > = {
    [ProtocolType.Cosmos]: 'hyp1jq304cthpx0lwhpqzrdjrcza559ukyy3sc4dw5',
    [ProtocolType.CosmosNative]: 'hyp1jq304cthpx0lwhpqzrdjrcza559ukyy3sc4dw5',
    [ProtocolType.Ethereum]: randomAddress(),
    [ProtocolType.Sealevel]: randomSvmAddress(),
    [ProtocolType.Starknet]: randomStarknetAddress(),
  };

  for (const [protocol, unsupportedChainAddress] of Object.entries(
    unsupportedChainsTestCases,
  )) {
    it(`should successfully enroll unsupported chain that specify the foreignDeployment field when the address is of protocol type ${protocol} (${unsupportedChainAddress})`, async () => {
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.sealevel.UNSUPPORTED_CHAIN
      ] = {
        type: TokenType.synthetic,
        owner: randomAddress(),
        foreignDeployment: unsupportedChainAddress,
      };
      writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

      const output = await hyperlaneWarp
        .deployRaw({
          warpRouteId: WARP_ROUTE_ID,
          skipConfirmationPrompts: true,
          extraArgs: [
            `--key.${ProtocolType.Ethereum}`,
            HYP_KEY_BY_PROTOCOL.ethereum,
            `--key.${ProtocolType.CosmosNative}`,
            HYP_KEY_BY_PROTOCOL.cosmosnative,
          ],
        })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.eql(0);

      await hyperlaneWarp.readRaw({
        warpRouteId: WARP_ROUTE_ID,
        outputPath: WARP_READ_OUTPUT_PATH,
      });

      const config: DerivedWarpRouteDeployConfig = readYamlOrJson(
        WARP_READ_OUTPUT_PATH,
      );

      const chainsToAssert = Object.keys(warpDeployConfig).filter(
        (chainName) =>
          chainName !== TEST_CHAIN_NAMES_BY_PROTOCOL.sealevel.UNSUPPORTED_CHAIN,
      );
      for (const chainName of chainsToAssert) {
        assertWarpRouteConfig(
          warpDeployConfig,
          config,
          coreAddressByChain,
          chainName,
        );

        expect(
          (config[chainName].remoteRouters ?? {})[
            TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.UNSUPPORTED_CHAIN.domainId
          ].address,
        ).to.eql(addressToBytes32(unsupportedChainAddress));
      }

      const warpCoreConfig: WarpCoreConfig = readYamlOrJson(WARP_CORE_PATH);
      const unsuportedChainData = warpCoreConfig.tokens.find(
        (tokenConfig) =>
          tokenConfig.chainName ===
          TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.UNSUPPORTED_CHAIN.name,
      );
      expect(
        unsuportedChainData,
        `Expected warp core config for chain ${TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.UNSUPPORTED_CHAIN.name} to be defined in the deployment output file`,
      ).not.to.be.undefined;
    });
  }
});
