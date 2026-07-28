import { expect } from 'chai';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import { DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY } from '@hyperlane-xyz/provider-sdk/warp';
import { SealevelSigner, createRpc } from '@hyperlane-xyz/sealevel-sdk';
import { airdropSol, createSplMint } from '@hyperlane-xyz/sealevel-sdk/testing';
import {
  TokenFeeType,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
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

const CHAIN_NAME = 'svmlocal1';
const REMOTE_CHAIN_NAME = 'anvil1';
const SVM_KEY = HYP_KEY_BY_PROTOCOL.sealevel;
const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/svm-read-warp-deploy.yaml`;

// SVM deploys programs from bytes — generous timeout for back-to-back CC deploys.
const SVM_WARP_READ_TIMEOUT = 600_000;

// Arbitrary specific remote-router H256 — distinct from DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY so
// the reader probes both slots when set in `remoteRouters`.
const SPECIFIC_REMOTE_ROUTER =
  '0x000000000000000000000000000000000000000000000000000000000000beef';

describe('hyperlane warp read CLI e2e tests (Sealevel)', function () {
  this.timeout(SVM_WARP_READ_TIMEOUT);

  let rpc: ReturnType<typeof createRpc>;
  let signer: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;
  let mailboxAddress: string;

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/svm-read-warp-read.yaml`,
  );

  before(async function () {
    const rpcUrl = TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl;
    rpc = createRpc(rpcUrl);
    signer = await SealevelSigner.connectWithSigner(
      TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      SVM_KEY,
    );

    await airdropSol(rpc, signer.getSignerAddress(), 50_000_000_000n);

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

    const coreAddresses: ChainAddresses = readYamlOrJson(
      CORE_ADDRESSES_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );
    mailboxAddress = coreAddresses.mailbox;
  });

  // Why this exists: `buildFeeReadContextFromWarpArtifactConfig` auto-injects
  // DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY into `knownRoutersPerDomain` for every discovered
  // domain. The reader for CC routing fee uses that context to enumerate
  // route PDAs (CC route PDAs are non-enumerable on-chain). Without the
  // auto-injection, a fee configured under DEFAULT_ROUTER would silently
  // never show up in the read output — these tests pin each branch:
  //   1. Only DEFAULT_ROUTER configured → reader surfaces it.
  //   2. Only specific router configured → DEFAULT_ROUTER stays absent.
  //   3. Both configured → both appear, isolated per router-key slot.
  it('should surface the DEFAULT_ROUTER CC routing fee entry when configured', async function () {
    const ownerAddress = signer.getSignerAddress();
    const mint = await createSplMint(rpc, signer, 9);
    const SYMBOL = 'CCDEF';
    const BPS = 50;

    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
    const config: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.crossCollateral,
        token: String(mint),
        name: 'CC Default Fee Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
        // Pins the remote chain as a known domain for the read context.
        remoteRouters: {
          [REMOTE_CHAIN_NAME]: { address: SPECIFIC_REMOTE_ROUTER },
        },
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: ownerAddress,
          feeContracts: {
            [REMOTE_CHAIN_NAME]: {
              [DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                bps: BPS,
              },
            },
          },
        },
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, config);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const readConfig = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const fee = readConfig[CHAIN_NAME].tokenFee;
    assert(fee, 'Expected tokenFee after deploy');
    assert(
      fee.type === TokenFeeType.CrossCollateralRoutingFee,
      `Expected CrossCollateralRoutingFee, got ${fee.type}`,
    );

    const remoteRoutes = fee.feeContracts[REMOTE_CHAIN_NAME];
    assert(
      remoteRoutes,
      `Expected feeContracts.${REMOTE_CHAIN_NAME} to be present`,
    );

    const defaultEntry = remoteRoutes[DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY];
    assert(
      defaultEntry,
      `Expected DEFAULT_ROUTER entry to be surfaced under feeContracts.${REMOTE_CHAIN_NAME}`,
    );
    assert(
      defaultEntry.type === TokenFeeType.LinearFee,
      `Expected LinearFee at DEFAULT_ROUTER, got ${defaultEntry.type}`,
    );
    expect(defaultEntry.bps).to.equal(BPS);
  });

  it('should not surface a DEFAULT_ROUTER entry when only a specific router is configured', async function () {
    const ownerAddress = signer.getSignerAddress();
    const mint = await createSplMint(rpc, signer, 9);
    const SYMBOL = 'CCSPEC';
    const BPS = 100;

    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
    const config: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.crossCollateral,
        token: String(mint),
        name: 'CC Specific Fee Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
        // Same enrollment as the positive case; the only difference is which
        // router-keyed leaf the fee lives under.
        remoteRouters: {
          [REMOTE_CHAIN_NAME]: { address: SPECIFIC_REMOTE_ROUTER },
        },
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: ownerAddress,
          feeContracts: {
            [REMOTE_CHAIN_NAME]: {
              [SPECIFIC_REMOTE_ROUTER]: {
                type: TokenFeeType.LinearFee,
                bps: BPS,
              },
            },
          },
        },
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, config);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const readConfig = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const fee = readConfig[CHAIN_NAME].tokenFee;
    assert(fee, 'Expected tokenFee after deploy');
    assert(
      fee.type === TokenFeeType.CrossCollateralRoutingFee,
      `Expected CrossCollateralRoutingFee, got ${fee.type}`,
    );

    const remoteRoutes = fee.feeContracts[REMOTE_CHAIN_NAME];
    assert(
      remoteRoutes,
      `Expected feeContracts.${REMOTE_CHAIN_NAME} to be present`,
    );

    // DEFAULT_ROUTER was auto-injected into the read context, but no PDA
    // exists at that slot on-chain → it must not appear in the output.
    expect(remoteRoutes[DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY]).to.be
      .undefined;

    const specificEntry = remoteRoutes[SPECIFIC_REMOTE_ROUTER];
    assert(
      specificEntry,
      `Expected specific router entry to be surfaced under feeContracts.${REMOTE_CHAIN_NAME}`,
    );
    assert(
      specificEntry.type === TokenFeeType.LinearFee,
      `Expected LinearFee at specific router, got ${specificEntry.type}`,
    );
    expect(specificEntry.bps).to.equal(BPS);
  });

  it('should surface both DEFAULT_ROUTER and specific router entries when both are configured', async function () {
    const ownerAddress = signer.getSignerAddress();
    const mint = await createSplMint(rpc, signer, 9);
    const SYMBOL = 'CCBOTH';
    const DEFAULT_BPS = 25;
    const SPECIFIC_BPS = 75;

    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
    const config: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.crossCollateral,
        token: String(mint),
        name: 'CC Both Fee Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
        remoteRouters: {
          [REMOTE_CHAIN_NAME]: { address: SPECIFIC_REMOTE_ROUTER },
        },
        tokenFee: {
          type: TokenFeeType.CrossCollateralRoutingFee,
          owner: ownerAddress,
          feeContracts: {
            [REMOTE_CHAIN_NAME]: {
              [DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY]: {
                type: TokenFeeType.LinearFee,
                bps: DEFAULT_BPS,
              },
              [SPECIFIC_REMOTE_ROUTER]: {
                type: TokenFeeType.LinearFee,
                bps: SPECIFIC_BPS,
              },
            },
          },
        },
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, config);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const readConfig = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const fee = readConfig[CHAIN_NAME].tokenFee;
    assert(fee, 'Expected tokenFee after deploy');
    assert(
      fee.type === TokenFeeType.CrossCollateralRoutingFee,
      `Expected CrossCollateralRoutingFee, got ${fee.type}`,
    );

    const remoteRoutes = fee.feeContracts[REMOTE_CHAIN_NAME];
    assert(
      remoteRoutes,
      `Expected feeContracts.${REMOTE_CHAIN_NAME} to be present`,
    );

    const defaultEntry = remoteRoutes[DEFAULT_CROSS_COLLATERAL_FEE_ROUTER_KEY];
    assert(
      defaultEntry,
      `Expected DEFAULT_ROUTER entry to be surfaced under feeContracts.${REMOTE_CHAIN_NAME}`,
    );
    assert(
      defaultEntry.type === TokenFeeType.LinearFee,
      `Expected LinearFee at DEFAULT_ROUTER, got ${defaultEntry.type}`,
    );
    expect(defaultEntry.bps).to.equal(DEFAULT_BPS);

    const specificEntry = remoteRoutes[SPECIFIC_REMOTE_ROUTER];
    assert(
      specificEntry,
      `Expected specific router entry to be surfaced under feeContracts.${REMOTE_CHAIN_NAME}`,
    );
    assert(
      specificEntry.type === TokenFeeType.LinearFee,
      `Expected LinearFee at specific router, got ${specificEntry.type}`,
    );
    expect(specificEntry.bps).to.equal(SPECIFIC_BPS);
  });
});
