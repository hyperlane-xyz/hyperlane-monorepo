import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';
import { type StartedTestContainer } from 'testcontainers';

import {
  createSignerWithPrivateKey,
  runCosmosNode,
} from '@hyperlane-xyz/cosmos-sdk/testing';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import { TokenType, type WarpRouteDeployConfig } from '@hyperlane-xyz/sdk';
import { type Address, ProtocolType } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
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
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
  getWarpId,
} from '../../constants.js';
import { runEvmNode } from '../../nodes.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

describe('hyperlane warp send cross-chain e2e tests', async function () {
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
  let evmChain1CoreAddress: ChainAddresses;
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

  let cosmosNodeInstance: StartedTestContainer;
  let evmNodeInstance: StartedTestContainer;

  before(async function () {
    cosmosNodeInstance = await runCosmosNode(
      TEST_CHAIN_METADATA_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
    );
    evmNodeInstance = await runEvmNode(
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    );

    const cosmosWallet = await createSignerWithPrivateKey(
      HYP_KEY_BY_PROTOCOL.cosmosnative,
      TEST_CHAIN_METADATA_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
    );
    cosmosNativeDeployerAddress = cosmosWallet.getSignerAddress();

    evmDeployerAddress = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address;

    [cosmosNativeChain1CoreAddress, evmChain1CoreAddress] = await Promise.all([
      cosmosNativeChain1Core.deployOrUseExistingCore(
        HYP_KEY_BY_PROTOCOL.cosmosnative,
      ),
      evmChain1Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);

    writeYamlOrJson(
      CORE_ADDRESSES_PATH_BY_PROTOCOL.sealevel.UNSUPPORTED_CHAIN,
      UNSUPPORTED_CHAIN_CORE_ADDRESSES,
    );
  });

  beforeEach(async function () {
    const warpDeployConfig: WarpRouteDeployConfig = {
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
        mailbox: evmChain1CoreAddress.mailbox,
        owner: evmDeployerAddress,
        name: TEST_TOKEN_SYMBOL,
        symbol: TEST_TOKEN_SYMBOL,
        decimals: 6,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    const deployOutput = await hyperlaneWarp
      .deployRaw({
        warpRouteId: WARP_ROUTE_ID,
        warpDeployPath: WARP_DEPLOY_PATH,
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

    expect(deployOutput.exitCode).to.eql(0);
  });

  after(async () => {
    await Promise.all([cosmosNodeInstance?.stop(), evmNodeInstance?.stop()]);
  });

  it('should send between EVM and CosmosNative with expected logs', async function () {
    // First: Cosmos (collateral) → EVM (synthetic) - locks collateral, mints synthetic
    // This must happen first so there's collateral to release for the reverse direction
    const cosmosToEvm = await hyperlaneWarp
      .sendRaw({
        origin: TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
        destination: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        warpRouteId: WARP_ROUTE_ID,
        amount: 1,
        quick: true,
        extraArgs: [
          `--key.${ProtocolType.Ethereum}`,
          HYP_KEY_BY_PROTOCOL.ethereum,
          `--key.${ProtocolType.CosmosNative}`,
          HYP_KEY_BY_PROTOCOL.cosmosnative,
        ],
      })
      .stdio('pipe')
      .nothrow();

    expect(cosmosToEvm.exitCode).to.eql(0);
    const cosmosToEvmText = cosmosToEvm.text();
    expect(cosmosToEvmText).to.include('Message ID:');
    expect(cosmosToEvmText).to.include('Explorer Link:');
    expect(cosmosToEvmText).to.include(
      `Skipping transfer validation for ${TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1}`,
    );

    // Second: EVM (synthetic) → Cosmos (collateral) - burns synthetic, releases collateral
    // Now there's locked collateral from the first transfer to release
    const evmToCosmos = await hyperlaneWarp
      .sendRaw({
        origin: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        destination: TEST_CHAIN_NAMES_BY_PROTOCOL.cosmosnative.CHAIN_NAME_1,
        warpRouteId: WARP_ROUTE_ID,
        amount: 1,
        relay: true,
        quick: true,
        extraArgs: [
          `--key.${ProtocolType.Ethereum}`,
          HYP_KEY_BY_PROTOCOL.ethereum,
          `--key.${ProtocolType.CosmosNative}`,
          HYP_KEY_BY_PROTOCOL.cosmosnative,
        ],
      })
      .stdio('pipe')
      .nothrow();

    expect(evmToCosmos.exitCode).to.eql(0);
    const evmToCosmosText = evmToCosmos.text();
    expect(evmToCosmosText).to.include('Message ID:');
    expect(evmToCosmosText).to.include('Explorer Link:');
    expect(evmToCosmosText).to.include(
      'Self-relay is only supported for EVM destinations.',
    );
  });
});
