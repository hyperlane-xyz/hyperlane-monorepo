import { expect } from 'chai';
import { Wallet } from 'ethers';
import { type StartedTestContainer } from 'testcontainers';
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
import {
  type SolanaTestValidator,
  airdropSol,
  createSplMint,
  getPreloadedPrograms,
  runSolanaNode,
} from '@hyperlane-xyz/sealevel-sdk/testing';
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
import { deployToken } from '../../ethereum/commands/helpers.js';
import {
  CORE_ADDRESSES_PATH_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  CROSS_CHAIN_CORE_CONFIG_PATH_BY_PROTOCOL,
  CROSS_CHAIN_E2E_TEST_TIMEOUT,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  getWarpCoreConfigPath,
} from '../../constants.js';
import { runEvmNode } from '../../nodes.js';

$.verbose = true;

const EVM_CHAIN = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
const SVM_CHAIN = TEST_CHAIN_NAMES_BY_PROTOCOL.sealevel.CHAIN_NAME_1;
const EVM_KEY = HYP_KEY_BY_PROTOCOL.ethereum;
const SVM_KEY = HYP_KEY_BY_PROTOCOL.sealevel;
const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/cc-evm-svm-warp-deploy.yaml`;

describe('hyperlane warp crossCollateral EVM+SVM e2e tests', function () {
  this.timeout(CROSS_CHAIN_E2E_TEST_TIMEOUT);

  let evmNodeInstance: StartedTestContainer;
  let svmNodeInstance: SolanaTestValidator;
  let svmProgramCleanup: (() => void) | undefined;

  let evmCoreAddresses: ChainAddresses;
  let svmCoreAddresses: ChainAddresses;
  let svmRpc: ReturnType<typeof createRpc>;
  let svmSigner: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;

  const evmCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    EVM_CHAIN,
    REGISTRY_PATH,
    CROSS_CHAIN_CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const svmCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Sealevel,
    SVM_CHAIN,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
  );

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/cc-evm-svm-warp-read.yaml`,
  );

  before(async function () {
    // Start both nodes
    const { programs, cleanup } = getPreloadedPrograms([]);
    svmProgramCleanup = cleanup;

    [evmNodeInstance, svmNodeInstance] = await Promise.all([
      runEvmNode(TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2),
      runSolanaNode(
        TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
        programs,
      ),
    ]);

    // Fund SVM deployer
    const rpcUrl = TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl;
    svmRpc = createRpc(rpcUrl);
    svmSigner = await SealevelSigner.connectWithSigner([rpcUrl], SVM_KEY);
    await airdropSol(svmRpc, svmSigner.getSignerAddress(), 50_000_000_000n);

    // Deploy core on both chains
    const svmCoreConfig = readYamlOrJson(CORE_CONFIG_PATH_BY_PROTOCOL.sealevel);
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      svmCoreConfig,
    );
    svmCore.setCoreInputPath(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );

    [evmCoreAddresses] = await Promise.all([
      evmCore.deployOrUseExistingCore(EVM_KEY),
      svmCore.deploy(SVM_KEY),
    ]);

    svmCoreAddresses = readYamlOrJson(
      CORE_ADDRESSES_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    ) as ChainAddresses;
  });

  after(async function () {
    await Promise.all([evmNodeInstance?.stop(), svmNodeInstance?.stop()]);
    svmProgramCleanup?.();
  });

  it('should deploy CC routes on EVM+SVM, combine, apply, and verify CC routers enrolled', async function () {
    const evmOwner = new Wallet(EVM_KEY).address;
    const svmOwner = svmSigner.getSignerAddress();

    // Deploy ERC20 tokens on EVM and SPL mints on SVM
    const DECIMALS = 9;
    const evmTokenA = await deployToken(
      EVM_KEY,
      EVM_CHAIN,
      DECIMALS,
      'CCTKNA',
      'CC Token A',
      REGISTRY_PATH,
    );
    const evmTokenB = await deployToken(
      EVM_KEY,
      EVM_CHAIN,
      DECIMALS,
      'CCTKNB',
      'CC Token B',
      REGISTRY_PATH,
    );
    const svmMintA = await createSplMint(svmRpc, svmSigner, DECIMALS);
    const svmMintB = await createSplMint(svmRpc, svmSigner, DECIMALS);

    // Deploy CC route A
    const warpIdA = createWarpRouteConfigId(
      'CCTKNA',
      `${EVM_CHAIN}-${SVM_CHAIN}`,
    );
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
      [EVM_CHAIN]: {
        type: TokenType.crossCollateral,
        token: evmTokenA.address,
        mailbox: evmCoreAddresses.mailbox,
        owner: evmOwner,
      },
      [SVM_CHAIN]: {
        type: TokenType.crossCollateral,
        token: String(svmMintA),
        mailbox: svmCoreAddresses.mailbox,
        owner: svmOwner,
        name: 'CC Token A',
        symbol: 'CCTKNA',
        decimals: DECIMALS,
      },
    } as WarpRouteDeployConfig);

    await warpCommands.deployRaw({
      warpRouteId: warpIdA,
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      skipConfirmationPrompts: true,
      extraArgs: [
        `--key.${ProtocolType.Ethereum}`,
        EVM_KEY,
        `--key.${ProtocolType.Sealevel}`,
        SVM_KEY,
      ],
    });

    // Deploy CC route B
    const warpIdB = createWarpRouteConfigId(
      'CCTKNB',
      `${EVM_CHAIN}-${SVM_CHAIN}`,
    );
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
      [EVM_CHAIN]: {
        type: TokenType.crossCollateral,
        token: evmTokenB.address,
        mailbox: evmCoreAddresses.mailbox,
        owner: evmOwner,
      },
      [SVM_CHAIN]: {
        type: TokenType.crossCollateral,
        token: String(svmMintB),
        mailbox: svmCoreAddresses.mailbox,
        owner: svmOwner,
        name: 'CC Token B',
        symbol: 'CCTKNB',
        decimals: DECIMALS,
      },
    } as WarpRouteDeployConfig);

    await warpCommands.deployRaw({
      warpRouteId: warpIdB,
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      skipConfirmationPrompts: true,
      extraArgs: [
        `--key.${ProtocolType.Ethereum}`,
        EVM_KEY,
        `--key.${ProtocolType.Sealevel}`,
        SVM_KEY,
      ],
    });

    // Combine routes to cross-enroll CC routers
    const mergedWarpRouteId = 'MULTI/test-cc-evm-svm';
    await $`${localTestRunCmdPrefix()} hyperlane warp combine \
      --registry ${REGISTRY_PATH} \
      --routes ${`${warpIdA},${warpIdB}`} \
      --output-warp-route-id ${mergedWarpRouteId} \
      --key.${ProtocolType.Ethereum} ${EVM_KEY} \
      --key.${ProtocolType.Sealevel} ${SVM_KEY} \
      --verbosity debug \
      --yes`;

    // Apply enrollment on-chain for each route
    await warpCommands.applyRaw({
      warpRouteId: warpIdA,
      skipConfirmationPrompts: true,
      extraArgs: [
        `--key.${ProtocolType.Ethereum}`,
        EVM_KEY,
        `--key.${ProtocolType.Sealevel}`,
        SVM_KEY,
      ],
    });
    await warpCommands.applyRaw({
      warpRouteId: warpIdB,
      skipConfirmationPrompts: true,
      extraArgs: [
        `--key.${ProtocolType.Ethereum}`,
        EVM_KEY,
        `--key.${ProtocolType.Sealevel}`,
        SVM_KEY,
      ],
    });

    // Read deployed configs to get SVM router addresses
    const warpCorePathA = getWarpCoreConfigPath('CCTKNA', [
      EVM_CHAIN,
      SVM_CHAIN,
    ]);
    const warpCorePathB = getWarpCoreConfigPath('CCTKNB', [
      EVM_CHAIN,
      SVM_CHAIN,
    ]);
    const coreConfigA = readYamlOrJson(warpCorePathA) as WarpCoreConfig;
    const coreConfigB = readYamlOrJson(warpCorePathB) as WarpCoreConfig;

    // Get SVM routers from both routes
    const svmTokenA = coreConfigA.tokens.find((t) => t.chainName === SVM_CHAIN);
    const svmTokenB = coreConfigB.tokens.find((t) => t.chainName === SVM_CHAIN);
    assert(svmTokenA?.addressOrDenom, 'Route A SVM token not found');
    assert(svmTokenB?.addressOrDenom, 'Route B SVM token not found');

    // Verify SVM CC routers are enrolled on-chain
    const reader = new SvmCrossCollateralTokenReader(svmRpc);

    const stateA = await reader.read(svmTokenA.addressOrDenom);
    const stateB = await reader.read(svmTokenB.addressOrDenom);

    const routerBHex32 = addressToBytes32(
      svmTokenB.addressOrDenom,
    ).toLowerCase();
    const routerAHex32 = addressToBytes32(
      svmTokenA.addressOrDenom,
    ).toLowerCase();

    const allRoutersA = Object.values(
      stateA.config.crossCollateralRouters,
    ).flatMap((s) => [...s]);
    expect(
      allRoutersA.map((r) => r.toLowerCase()),
      'SVM Route A should have SVM Route B enrolled as CC router',
    ).to.include(routerBHex32);

    const allRoutersB = Object.values(
      stateB.config.crossCollateralRouters,
    ).flatMap((s) => [...s]);
    expect(
      allRoutersB.map((r) => r.toLowerCase()),
      'SVM Route B should have SVM Route A enrolled as CC router',
    ).to.include(routerAHex32);
  });
});
