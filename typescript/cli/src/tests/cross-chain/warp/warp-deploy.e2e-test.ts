import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  ChainName,
  DerivedWarpRouteDeployConfig,
  TokenType,
  WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  addressToBytes32,
  isObjEmpty,
} from '@hyperlane-xyz/utils';

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
  UNSUPPORTED_CHAIN_CORE_ADDRESSES,
  WARP_READ_OUTPUT_PATH,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
  getWarpId,
} from '../../constants.js';
import { runAnvilNode, runCosmosNode } from '../../nodes.js';

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

  const TOKEN_SYMBOL = 'TST';
  const WARP_CORE_PATH = getWarpCoreConfigPath(TOKEN_SYMBOL, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
  ]);
  const WARP_DEPLOY_PATH = getWarpDeployConfigPath(TOKEN_SYMBOL, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
  ]);
  const WARP_ROUTE_ID = getWarpId(TOKEN_SYMBOL, [
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
    await runAnvilNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2);

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
        name: TOKEN_SYMBOL,
        symbol: TOKEN_SYMBOL,
        decimals: 6,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.synthetic,
        mailbox: evmChain1CoreCoreAddress.mailbox,
        owner: evmDeployerAddress,
        name: TOKEN_SYMBOL,
        symbol: TOKEN_SYMBOL,
        decimals: 6,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);
  });

  function assertWarpRouteConfig(
    warpDeployConfig: Readonly<WarpRouteDeployConfig>,
    derivedWarpDeployConfig: Readonly<WarpRouteDeployConfig>,
    coreAddressByChain: ChainMap<ChainAddresses>,
    chainName: ChainName,
  ): void {
    expect(derivedWarpDeployConfig[chainName].type).to.equal(
      warpDeployConfig[chainName].type,
    );
    expect(derivedWarpDeployConfig[chainName].owner).to.equal(
      warpDeployConfig[chainName].owner,
    );

    expect(warpDeployConfig[chainName].mailbox).to.equal(
      coreAddressByChain[chainName].mailbox,
    );
    expect(isObjEmpty(derivedWarpDeployConfig[chainName].destinationGas ?? {}))
      .to.be.false;
    expect(isObjEmpty(derivedWarpDeployConfig[chainName].remoteRouters ?? {}))
      .to.be.false;
  }

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

  it('should successfully enroll unsupported chains that specify the foreignDeployment field', async () => {
    const unsupportedChainAddress = randomAddress();
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.sealevel.UNSUPPORTED_CHAIN] =
      {
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
  });
});
