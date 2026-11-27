import { expect } from 'chai';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type HypTokenRouterConfig,
  TokenFeeType,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  DEFAULT_EVM_WARP_CORE_PATH,
  DEFAULT_EVM_WARP_DEPLOY_PATH,
  DEFAULT_EVM_WARP_ID,
  DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../../constants.js';

const CHAIN_2 = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
const CHAIN_3 = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3;
const CHAIN_4 = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_4;
const OWNER = HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum;
const HYP_KEY = HYP_KEY_BY_PROTOCOL.ethereum;

// Regression for the RoutingFee "additive-only apply" gap: a destination removed
// from the target config must be cleared on-chain (setFeeContract(domain, 0)),
// not left wired. Drives the removal through a real `hyperlane warp apply`.
describe('hyperlane warp apply RoutingFee destination removal', async function () {
  this.timeout(3 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses;
  let chain3Addresses: ChainAddresses;
  let chain4Addresses: ChainAddresses;

  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    CHAIN_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );
  const evmChain3Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    CHAIN_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
  );
  const evmChain4Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    CHAIN_4,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_4,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  );

  before(async function () {
    [chain2Addresses, chain3Addresses, chain4Addresses] = await Promise.all([
      evmChain2Core.deployOrUseExistingCore(HYP_KEY),
      evmChain3Core.deployOrUseExistingCore(HYP_KEY),
      evmChain4Core.deployOrUseExistingCore(HYP_KEY),
    ]);
  });

  // Routing fee lives on the chain3 synthetic token (so the LinearFee leaf token
  // resolves to the synthetic token). It routes two destinations: chain2 + chain4,
  // both enrolled remote routers so the reader observes them via router.domains().
  function buildDeployConfig(
    feeDestinations: readonly string[],
  ): WarpRouteDeployConfig {
    const feeContracts = Object.fromEntries(
      feeDestinations.map((chain) => [
        chain,
        { type: TokenFeeType.LinearFee, bps: 50 },
      ]),
    );

    const chain2Config: HypTokenRouterConfig = {
      type: TokenType.native,
      mailbox: chain2Addresses.mailbox,
      owner: OWNER,
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    };
    const chain3Config: HypTokenRouterConfig = {
      type: TokenType.synthetic,
      mailbox: chain3Addresses.mailbox,
      owner: OWNER,
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
      tokenFee: {
        type: TokenFeeType.RoutingFee,
        owner: OWNER,
        feeContracts,
      },
    };
    const chain4Config: HypTokenRouterConfig = {
      type: TokenType.synthetic,
      mailbox: chain4Addresses.mailbox,
      owner: OWNER,
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    };

    return {
      [CHAIN_2]: chain2Config,
      [CHAIN_3]: chain3Config,
      [CHAIN_4]: chain4Config,
    };
  }

  function readChain3RoutingFeeDestinations(): string[] {
    const deployConfig = readYamlOrJson<WarpRouteDeployConfig>(
      DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
    );
    const tokenFee = deployConfig[CHAIN_3].tokenFee;
    assert(
      tokenFee?.type === TokenFeeType.RoutingFee,
      `expected chain3 tokenFee to be ${TokenFeeType.RoutingFee}`,
    );
    return Object.keys(tokenFee.feeContracts);
  }

  it('clears a routing fee destination removed from the target config', async function () {
    // 1. Deploy the route with fee destinations chain2 + chain4.
    writeYamlOrJson(
      DEFAULT_EVM_WARP_DEPLOY_PATH,
      buildDeployConfig([CHAIN_2, CHAIN_4]),
    );
    await evmWarpCommands.deploy(HYP_KEY, DEFAULT_EVM_WARP_ID);

    // Sanity: both destinations are wired on-chain after deploy.
    await evmWarpCommands.readConfig(CHAIN_3, DEFAULT_EVM_WARP_CORE_PATH);
    expect(readChain3RoutingFeeDestinations().sort()).to.deep.equal(
      [CHAIN_2, CHAIN_4].sort(),
    );

    // 2. Drop chain4 from the routing fee config and apply.
    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, buildDeployConfig([CHAIN_2]));
    const res = await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY,
    });
    expect(res.text()).not.to.include(
      'Error in submitWarpApplyTransactions Error:',
    );

    // 3. chain4 pointer cleared on-chain; chain2 remains.
    await evmWarpCommands.readConfig(CHAIN_3, DEFAULT_EVM_WARP_CORE_PATH);
    const remaining = readChain3RoutingFeeDestinations();
    expect(remaining).to.deep.equal([CHAIN_2]);
    expect(remaining).to.not.include(CHAIN_4);
  });
});
