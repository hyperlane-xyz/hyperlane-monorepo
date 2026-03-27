import { expect } from 'chai';
import { Wallet } from 'ethers';
import { type StartedTestContainer } from 'testcontainers';

import { TEST_STARKNET_ACCOUNT_ADDRESS } from '@hyperlane-xyz/starknet-sdk/testing';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type DerivedWarpRouteDeployConfig,
  IsmType,
  TokenType,
  type WarpRouteDeployConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CROSS_CHAIN_E2E_TEST_TIMEOUT,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  WARP_READ_OUTPUT_PATH,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
  getWarpId,
} from '../../constants.js';
import { runEvmNode, runStarknetNode } from '../../nodes.js';

describe('hyperlane warp apply e2e tests (Starknet x EVM)', async function () {
  this.timeout(2 * CROSS_CHAIN_E2E_TEST_TIMEOUT);

  const starknetTokenData =
    TEST_CHAIN_METADATA_BY_PROTOCOL.starknet.CHAIN_NAME_1.nativeToken;
  assert(starknetTokenData?.denom, 'Expected Starknet native token denom');

  let starknetCoreAddress: ChainAddresses;
  const starknetCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Starknet,
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  );

  let evmCoreAddress: ChainAddresses;
  const evmCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const WARP_CORE_PATH = getWarpCoreConfigPath(starknetTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);
  const WARP_DEPLOY_PATH = getWarpDeployConfigPath(starknetTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);
  const WARP_ROUTE_ID = getWarpId(starknetTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Starknet,
    REGISTRY_PATH,
    WARP_CORE_PATH,
  );

  let starknetNode: StartedTestContainer;
  let evmNode: StartedTestContainer;
  let previousAccountAddress: string | undefined;
  let warpDeployConfig: WarpRouteDeployConfig;

  before(async function () {
    previousAccountAddress = process.env.HYP_ACCOUNT_ADDRESS_STARKNET;
    process.env.HYP_ACCOUNT_ADDRESS_STARKNET = TEST_STARKNET_ACCOUNT_ADDRESS;

    [starknetNode, evmNode] = await Promise.all([
      runStarknetNode(TEST_CHAIN_METADATA_BY_PROTOCOL.starknet.CHAIN_NAME_1),
      runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2),
    ]);

    [starknetCoreAddress, evmCoreAddress] = await Promise.all([
      starknetCore.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.starknet),
      evmCore.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);
  });

  after(async () => {
    await Promise.all([starknetNode?.stop(), evmNode?.stop()].filter(Boolean));
    if (previousAccountAddress === undefined) {
      delete process.env.HYP_ACCOUNT_ADDRESS_STARKNET;
    } else {
      process.env.HYP_ACCOUNT_ADDRESS_STARKNET = previousAccountAddress;
    }
  });

  beforeEach(async () => {
    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1]: {
        type: TokenType.native,
        mailbox: starknetCoreAddress.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.synthetic,
        mailbox: evmCoreAddress.mailbox,
        owner: new Wallet(HYP_KEY_BY_PROTOCOL.ethereum).address,
        name: starknetTokenData.name,
        symbol: starknetTokenData.symbol,
        decimals: starknetTokenData.decimals,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);
    await hyperlaneWarp.deployRaw({
      warpRouteId: WARP_ROUTE_ID,
      skipConfirmationPrompts: true,
      extraArgs: [
        `--key.${ProtocolType.Starknet}`,
        HYP_KEY_BY_PROTOCOL.starknet,
        `--key.${ProtocolType.Ethereum}`,
        HYP_KEY_BY_PROTOCOL.ethereum,
      ],
    });
  });

  it('should update Starknet ISM on a Starknet x EVM route', async () => {
    warpDeployConfig[
      TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1
    ].interchainSecurityModule = {
      type: IsmType.MESSAGE_ID_MULTISIG,
      threshold: 1,
      validators: [randomAddress()],
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      extraArgs: [
        `--key.${ProtocolType.Starknet}`,
        HYP_KEY_BY_PROTOCOL.starknet,
        `--key.${ProtocolType.Ethereum}`,
        HYP_KEY_BY_PROTOCOL.ethereum,
      ],
      skipConfirmationPrompts: true,
    });

    await hyperlaneWarp.readRaw({
      warpRouteId: WARP_ROUTE_ID,
      outputPath: WARP_READ_OUTPUT_PATH,
    });

    const config: DerivedWarpRouteDeployConfig = readYamlOrJson(
      WARP_READ_OUTPUT_PATH,
    );
    const ismConfig =
      config[TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1]
        .interchainSecurityModule;

    assert(
      ismConfig && typeof ismConfig !== 'string',
      'Expected Starknet ISM config',
    );
    assert(
      ismConfig.type === IsmType.MESSAGE_ID_MULTISIG,
      'Expected messageIdMultisigIsm',
    );
    expect(ismConfig.validators).to.have.length(1);
  });
});
