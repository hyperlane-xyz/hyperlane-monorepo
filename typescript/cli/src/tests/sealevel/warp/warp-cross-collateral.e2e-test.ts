import { expect } from 'chai';
import { $ } from 'zx';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  SealevelSigner,
  SvmCrossCollateralTokenReader,
  createRpc,
} from '@hyperlane-xyz/sealevel-sdk';
import { airdropSol, createSplMint } from '@hyperlane-xyz/sealevel-sdk/testing';
import {
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { localTestRunCmdPrefix } from '../../commands/helpers.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_ADDRESSES_PATH_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  getWarpCoreConfigPath,
} from '../../constants.js';

$.verbose = true;

const CHAIN_NAME = 'svmlocal1';
const SVM_KEY = HYP_KEY_BY_PROTOCOL.sealevel;
const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/svm-cc-warp-deploy.yaml`;

// SVM deploys programs from bytes — needs generous timeout
const SVM_WARP_CC_TIMEOUT = 600_000;

describe('hyperlane warp crossCollateral CLI e2e tests (Sealevel)', function () {
  this.timeout(SVM_WARP_CC_TIMEOUT);

  let rpc: ReturnType<typeof createRpc>;
  let signer: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;
  let mailboxAddress: string;

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/svm-cc-warp-read.yaml`,
  );

  before(async function () {
    const rpcUrl = TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl;
    rpc = createRpc(rpcUrl);
    signer = await SealevelSigner.connectWithSigner([rpcUrl], SVM_KEY);

    // Fund deployer for mint creation
    await airdropSol(rpc, signer.getSignerAddress(), 50_000_000_000n);

    // Deploy core if not already deployed
    const coreAddressesPath =
      CORE_ADDRESSES_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1;
    try {
      readYamlOrJson(coreAddressesPath);
    } catch {
      const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
        ProtocolType.Sealevel,
        CHAIN_NAME,
        REGISTRY_PATH,
        CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
        CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      );

      const coreConfig = readYamlOrJson(CORE_CONFIG_PATH_BY_PROTOCOL.sealevel);
      writeYamlOrJson(
        CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
        coreConfig,
      );
      hyperlaneCore.setCoreInputPath(
        CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      );
      await hyperlaneCore.deploy(SVM_KEY);
    }

    const coreAddresses: ChainAddresses = readYamlOrJson(coreAddressesPath);
    mailboxAddress = coreAddresses.mailbox;
  });

  it('should deploy two CC routes, combine, apply, and verify CC routers enrolled', async function () {
    // Create two SPL mints (simulating different stablecoins)
    const mintA = await createSplMint(rpc, signer, 9);
    const mintB = await createSplMint(rpc, signer, 9);

    const ownerAddress = signer.getSignerAddress();

    // Deploy CC route 1 (Token A)
    const warpIdA = createWarpRouteConfigId('TKNA', CHAIN_NAME);
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
      [CHAIN_NAME]: {
        type: TokenType.crossCollateral,
        token: String(mintA),
        name: 'Token A',
        symbol: 'TKNA',
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
      },
    } as WarpRouteDeployConfig);
    await warpCommands.deploy(SVM_KEY, warpIdA, WARP_DEPLOY_OUTPUT_PATH);

    // Deploy CC route 2 (Token B)
    const warpIdB = createWarpRouteConfigId('TKNB', CHAIN_NAME);
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
      [CHAIN_NAME]: {
        type: TokenType.crossCollateral,
        token: String(mintB),
        name: 'Token B',
        symbol: 'TKNB',
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
      },
    } as WarpRouteDeployConfig);
    await warpCommands.deploy(SVM_KEY, warpIdB, WARP_DEPLOY_OUTPUT_PATH);

    // Combine routes to cross-enroll CC routers
    const mergedWarpRouteId = 'MULTI/test-svm-cc';
    await $`${localTestRunCmdPrefix()} hyperlane warp combine \
      --registry ${REGISTRY_PATH} \
      --routes ${`${warpIdA},${warpIdB}`} \
      --output-warp-route-id ${mergedWarpRouteId} \
      --key.sealevel ${SVM_KEY} \
      --verbosity debug \
      --yes`;

    // Apply enrollment on-chain for each route
    await warpCommands.applyRaw({
      warpRouteId: warpIdA,
      privateKey: SVM_KEY,
      skipConfirmationPrompts: true,
    });
    await warpCommands.applyRaw({
      warpRouteId: warpIdB,
      privateKey: SVM_KEY,
      skipConfirmationPrompts: true,
    });

    // Read deployed configs to get router addresses
    const warpCorePathA = getWarpCoreConfigPath('TKNA', [CHAIN_NAME]);
    const warpCorePathB = getWarpCoreConfigPath('TKNB', [CHAIN_NAME]);
    const coreConfigA = readYamlOrJson(warpCorePathA) as WarpCoreConfig;
    const coreConfigB = readYamlOrJson(warpCorePathB) as WarpCoreConfig;

    const tokenA = coreConfigA.tokens.find((t) => t.chainName === CHAIN_NAME);
    const tokenB = coreConfigB.tokens.find((t) => t.chainName === CHAIN_NAME);
    assert(tokenA?.addressOrDenom, 'Route A token not found in warp config');
    assert(tokenB?.addressOrDenom, 'Route B token not found in warp config');
    const routerA = tokenA.addressOrDenom;
    const routerB = tokenB.addressOrDenom;

    // Verify CC routers are enrolled on-chain using the SVM SDK reader
    const reader = new SvmCrossCollateralTokenReader(rpc);

    const stateA = await reader.read(routerA);
    const stateB = await reader.read(routerB);

    // Convert base58 router addresses to canonical lowercase hex32
    const routerAHex32 = addressToBytes32(routerA).toLowerCase();
    const routerBHex32 = addressToBytes32(routerB).toLowerCase();

    // Route A should have route B's router enrolled as CC router
    const allRoutersA = Object.values(
      stateA.config.crossCollateralRouters,
    ).flatMap((s) => [...s]);
    expect(
      allRoutersA.map((r) => r.toLowerCase()),
      'Route A should have route B enrolled as CC router',
    ).to.include(routerBHex32);

    // Route B should have route A's router enrolled as CC router
    const allRoutersB = Object.values(
      stateB.config.crossCollateralRouters,
    ).flatMap((s) => [...s]);
    expect(
      allRoutersB.map((r) => r.toLowerCase()),
      'Route B should have route A enrolled as CC router',
    ).to.include(routerAHex32);
  });
});
