import { expect } from 'chai';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type DerivedWarpRouteDeployConfig,
  HookType,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  STARKNET_E2E_TEST_TIMEOUT,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  WARP_READ_OUTPUT_PATH,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
  getWarpId,
} from '../../constants.js';
import { normalizeStarknetAddress } from '../helpers.js';

describe('hyperlane warp apply Hook updates (Starknet E2E tests)', async function () {
  this.timeout(STARKNET_E2E_TEST_TIMEOUT);

  const nativeTokenData =
    TEST_CHAIN_METADATA_BY_PROTOCOL.starknet.CHAIN_NAME_1.nativeToken;
  assert(nativeTokenData?.denom, 'Expected Starknet native token denom');

  let chain1CoreAddress: ChainAddresses;
  const hyperlaneCore1 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Starknet,
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  );

  let chain2CoreAddress: ChainAddresses;
  const hyperlaneCore2 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Starknet,
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_2,
  );

  const WARP_CORE_PATH = getWarpCoreConfigPath(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);
  const WARP_DEPLOY_PATH = getWarpDeployConfigPath(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);
  const WARP_ROUTE_ID = getWarpId(nativeTokenData.symbol, [
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  ]);

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Starknet,
    REGISTRY_PATH,
    WARP_CORE_PATH,
  );

  before(async function () {
    [chain1CoreAddress, chain2CoreAddress] = await Promise.all([
      hyperlaneCore1.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.starknet),
      hyperlaneCore2.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.starknet),
    ]);
  });

  let warpDeployConfig: WarpRouteDeployConfig;
  beforeEach(async () => {
    warpDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1]: {
        type: TokenType.native,
        mailbox: chain1CoreAddress.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_2]: {
        type: TokenType.synthetic,
        mailbox: chain2CoreAddress.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        name: nativeTokenData.name,
        symbol: nativeTokenData.symbol,
        decimals: nativeTokenData.decimals,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);
    await hyperlaneWarp.deployRaw({
      warpRouteId: WARP_ROUTE_ID,
      skipConfirmationPrompts: true,
      privateKey: HYP_KEY_BY_PROTOCOL.starknet,
    });
  });

  async function readChain1Hook() {
    await hyperlaneWarp.readRaw({
      warpRouteId: WARP_ROUTE_ID,
      outputPath: WARP_READ_OUTPUT_PATH,
    });

    const updatedWarpDeployConfig: DerivedWarpRouteDeployConfig =
      readYamlOrJson(WARP_READ_OUTPUT_PATH);
    return updatedWarpDeployConfig[
      TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1
    ].hook;
  }

  it('should update Hook from nothing to MerkleTreeHook', async () => {
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1].hook =
      {
        type: HookType.MERKLE_TREE,
      };

    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.starknet,
      skipConfirmationPrompts: true,
    });

    const hookConfig = await readChain1Hook();

    assert(
      hookConfig && typeof hookConfig !== 'string',
      'Expected Hook config',
    );
    expect(hookConfig.type).to.equal(HookType.MERKLE_TREE);
    expect(hookConfig.address).to.be.a('string');
  });

  it('should update Hook from MerkleTreeHook to protocolFee', async () => {
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1].hook =
      {
        type: HookType.MERKLE_TREE,
      };
    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.starknet,
      skipConfirmationPrompts: true,
    });

    const firstHook = await readChain1Hook();
    assert(firstHook && typeof firstHook !== 'string', 'Expected first Hook');
    expect(firstHook.type).to.equal(HookType.MERKLE_TREE);

    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1].hook =
      {
        type: HookType.PROTOCOL_FEE,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        beneficiary: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        maxProtocolFee: '100',
        protocolFee: '10',
      };
    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.starknet,
      skipConfirmationPrompts: true,
    });

    const secondHook = await readChain1Hook();
    assert(
      secondHook && typeof secondHook !== 'string',
      'Expected second Hook',
    );
    expect(secondHook.type).to.equal(HookType.PROTOCOL_FEE);
    assert(
      secondHook.type === HookType.PROTOCOL_FEE,
      'Expected protocolFee Hook',
    );
    expect(secondHook.address).to.not.equal(firstHook.address);
    expect(normalizeStarknetAddress(secondHook.owner)).to.equal(
      normalizeStarknetAddress(HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet),
    );
    expect(normalizeStarknetAddress(secondHook.beneficiary)).to.equal(
      normalizeStarknetAddress(HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet),
    );
    expect(secondHook.protocolFee).to.equal('10');
  });

  it('should update protocolFee Hook config without redeployment', async () => {
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1].hook =
      {
        type: HookType.PROTOCOL_FEE,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        beneficiary: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        maxProtocolFee: '100',
        protocolFee: '10',
      };
    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.starknet,
      skipConfirmationPrompts: true,
    });

    const firstHook = await readChain1Hook();
    assert(firstHook && typeof firstHook !== 'string', 'Expected first Hook');
    expect(firstHook.type).to.equal(HookType.PROTOCOL_FEE);

    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1].hook =
      {
        type: HookType.PROTOCOL_FEE,
        owner: BURN_ADDRESS_BY_PROTOCOL.starknet,
        beneficiary: BURN_ADDRESS_BY_PROTOCOL.starknet,
        maxProtocolFee: '100',
        protocolFee: '11',
      };
    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.starknet,
      skipConfirmationPrompts: true,
    });

    const secondHook = await readChain1Hook();
    assert(
      secondHook && typeof secondHook !== 'string',
      'Expected second Hook',
    );
    expect(secondHook.type).to.equal(HookType.PROTOCOL_FEE);
    assert(
      secondHook.type === HookType.PROTOCOL_FEE,
      'Expected protocolFee Hook',
    );
    expect(secondHook.address).to.equal(firstHook.address);
    expect(normalizeStarknetAddress(secondHook.owner)).to.equal(
      normalizeStarknetAddress(BURN_ADDRESS_BY_PROTOCOL.starknet),
    );
    expect(normalizeStarknetAddress(secondHook.beneficiary)).to.equal(
      normalizeStarknetAddress(BURN_ADDRESS_BY_PROTOCOL.starknet),
    );
    expect(secondHook.protocolFee).to.equal('11');
  });

  it('should not redeploy protocolFee Hook when applying the same config twice', async () => {
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1].hook =
      {
        type: HookType.PROTOCOL_FEE,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        beneficiary: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
        maxProtocolFee: '100',
        protocolFee: '10',
      };
    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.starknet,
      skipConfirmationPrompts: true,
    });

    const firstHook = await readChain1Hook();
    assert(firstHook && typeof firstHook !== 'string', 'Expected first Hook');

    await hyperlaneWarp.applyRaw({
      warpRouteId: WARP_ROUTE_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.starknet,
      skipConfirmationPrompts: true,
    });

    const secondHook = await readChain1Hook();
    assert(
      secondHook && typeof secondHook !== 'string',
      'Expected second Hook',
    );
    expect(secondHook.address).to.equal(firstHook.address);
  });
});
