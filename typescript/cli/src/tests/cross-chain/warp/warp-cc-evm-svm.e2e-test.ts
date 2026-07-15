import { expect } from 'chai';
import { Wallet, providers } from 'ethers';
import { type StartedTestContainer } from 'testcontainers';
import { $ } from 'zx';

import { CrossCollateralRouter__factory } from '@hyperlane-xyz/core';
import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  FALLBACK_SIMULATION_PAYER,
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
  TokenFeeType,
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
  BURN_ADDRESS_BY_PROTOCOL,
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
import { expectCcRouterEnrolled } from '../../utils.js';

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
    const warpDeployConfigA: WarpRouteDeployConfig = {
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
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfigA);

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
    const warpDeployConfigB: WarpRouteDeployConfig = {
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
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfigB);

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

    // Read deployed configs to get token addresses
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

    const svmTokenA = coreConfigA.tokens.find((t) => t.chainName === SVM_CHAIN);
    const svmTokenB = coreConfigB.tokens.find((t) => t.chainName === SVM_CHAIN);
    assert(svmTokenA?.addressOrDenom, 'Route A SVM token not found');
    assert(svmTokenB?.addressOrDenom, 'Route B SVM token not found');

    const evmWarpTokenA = coreConfigA.tokens.find(
      (t) => t.chainName === EVM_CHAIN,
    );
    const evmWarpTokenB = coreConfigB.tokens.find(
      (t) => t.chainName === EVM_CHAIN,
    );
    assert(evmWarpTokenA?.addressOrDenom, 'Route A EVM token not found');
    assert(evmWarpTokenB?.addressOrDenom, 'Route B EVM token not found');

    const evmDomainId =
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.domainId;
    const svmDomainId =
      TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.domainId;

    // --- Verify SVM CC routers enrolled on-chain ---
    const reader = new SvmCrossCollateralTokenReader(svmRpc);

    const stateA = await reader.read(svmTokenA.addressOrDenom);
    const stateB = await reader.read(svmTokenB.addressOrDenom);

    expectCcRouterEnrolled(
      stateA.config.crossCollateralRouters,
      svmDomainId,
      svmTokenB.addressOrDenom,
      `SVM Route A should have SVM Route B enrolled as CC router on domain ${svmDomainId}`,
    );
    expectCcRouterEnrolled(
      stateB.config.crossCollateralRouters,
      svmDomainId,
      svmTokenA.addressOrDenom,
      `SVM Route B should have SVM Route A enrolled as CC router on domain ${svmDomainId}`,
    );

    // --- Verify EVM CC routers enrolled on-chain ---
    const evmRpcUrl =
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.rpcUrl;
    const evmWallet = new Wallet(EVM_KEY).connect(
      new providers.JsonRpcProvider(evmRpcUrl),
    );

    const evmRouterA = CrossCollateralRouter__factory.connect(
      evmWarpTokenA.addressOrDenom,
      evmWallet,
    );
    const evmRouterB = CrossCollateralRouter__factory.connect(
      evmWarpTokenB.addressOrDenom,
      evmWallet,
    );

    const evmRouterBHex32 = addressToBytes32(
      evmWarpTokenB.addressOrDenom,
    ).toLowerCase();
    const evmRouterAHex32 = addressToBytes32(
      evmWarpTokenA.addressOrDenom,
    ).toLowerCase();

    // EVM Route A should have EVM Route B enrolled on local EVM domain
    const evmCCRoutersA = (
      await evmRouterA.getCrossCollateralRouters(evmDomainId)
    ).map((r: string) => r.toLowerCase());
    expect(
      evmCCRoutersA,
      `EVM Route A should have EVM Route B enrolled as CC router on domain ${evmDomainId}`,
    ).to.include(evmRouterBHex32);

    // EVM Route B should have EVM Route A enrolled on local EVM domain
    const evmCCRoutersB = (
      await evmRouterB.getCrossCollateralRouters(evmDomainId)
    ).map((r: string) => r.toLowerCase());
    expect(
      evmCCRoutersB,
      `EVM Route B should have EVM Route A enrolled as CC router on domain ${evmDomainId}`,
    ).to.include(evmRouterAHex32);
  });

  it('should deploy EVM collateral + SVM synthetic with RoutingFee tokenFee without error', async function () {
    const evmOwner = new Wallet(EVM_KEY).address;
    const svmOwner = svmSigner.getSignerAddress();
    const DECIMALS = 9;
    const SYMBOL = 'RTKN';

    const evmToken = await deployToken(
      EVM_KEY,
      EVM_CHAIN,
      DECIMALS,
      SYMBOL,
      'Routing Token',
      REGISTRY_PATH,
    );

    const warpId = createWarpRouteConfigId(SYMBOL, `${EVM_CHAIN}-${SVM_CHAIN}`);
    const warpDeployConfig: WarpRouteDeployConfig = {
      [EVM_CHAIN]: {
        type: TokenType.collateral,
        token: evmToken.address,
        mailbox: evmCoreAddresses.mailbox,
        owner: evmOwner,
        tokenFee: {
          type: TokenFeeType.RoutingFee,
          owner: evmOwner,
          feeContracts: {
            [SVM_CHAIN]: {
              type: TokenFeeType.LinearFee,
              bps: 50,
            },
          },
        },
      },
      [SVM_CHAIN]: {
        type: TokenType.synthetic,
        mailbox: svmCoreAddresses.mailbox,
        owner: svmOwner,
        name: 'Routing Token',
        symbol: SYMBOL,
        decimals: DECIMALS,
        metadataUri: 'https://test.example.com/rtkn-metadata.json',
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);

    // Before the fix, enrollCrossChainRouters would fail with a
    // RoutingFeeInputConfigSchema validation error because the EVM reader
    // returns empty feeContracts when no SVM routers are enrolled yet.
    await warpCommands.deployRaw({
      warpRouteId: warpId,
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      skipConfirmationPrompts: true,
      extraArgs: [
        `--key.${ProtocolType.Ethereum}`,
        EVM_KEY,
        `--key.${ProtocolType.Sealevel}`,
        SVM_KEY,
      ],
    });

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [EVM_CHAIN, SVM_CHAIN]);
    const deployedConfig = await warpCommands.readConfig(
      EVM_CHAIN,
      warpCorePath,
    );
    expect(deployedConfig[EVM_CHAIN].tokenFee?.type).to.equal(
      TokenFeeType.RoutingFee,
    );
  });

  it('should deploy an EVM+SVM warp whose SVM owner is not the deployer and still enroll cross-chain routers', async function () {
    const evmOwner = new Wallet(EVM_KEY).address;
    // A non-deployer owner for the SVM side. The deploy runs with the deployer
    // key and cross-chain router enrollment happens after create(), so the SVM
    // warp must stay deployer-owned through enrollment and only be handed to
    // this owner during it. If create() applied the configured owner up front,
    // the deployer could no longer sign the enrollment and the deploy would
    // fail.
    const svmOwner = BURN_ADDRESS_BY_PROTOCOL[ProtocolType.Sealevel];
    const DECIMALS = 9;
    const SYMBOL = 'NDOWN';

    const evmToken = await deployToken(
      EVM_KEY,
      EVM_CHAIN,
      DECIMALS,
      SYMBOL,
      'Non-deployer Owner Token',
      REGISTRY_PATH,
    );

    const warpId = createWarpRouteConfigId(SYMBOL, `${EVM_CHAIN}-${SVM_CHAIN}`);
    const warpDeployConfig: WarpRouteDeployConfig = {
      [EVM_CHAIN]: {
        type: TokenType.collateral,
        token: evmToken.address,
        mailbox: evmCoreAddresses.mailbox,
        owner: evmOwner,
      },
      [SVM_CHAIN]: {
        type: TokenType.synthetic,
        mailbox: svmCoreAddresses.mailbox,
        owner: svmOwner,
        name: 'Non-deployer Owner Token',
        symbol: SYMBOL,
        decimals: DECIMALS,
        metadataUri: 'https://test.example.com/ndown-metadata.json',
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpDeployConfig);

    // Deploy must succeed: enrollment is authorized by the deployer key because
    // ownership is handed to svmOwner only during enrollment, not at create.
    await warpCommands.deployRaw({
      warpRouteId: warpId,
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      skipConfirmationPrompts: true,
      extraArgs: [
        `--key.${ProtocolType.Ethereum}`,
        EVM_KEY,
        `--key.${ProtocolType.Sealevel}`,
        SVM_KEY,
      ],
    });

    // Reading an SVM warp simulates an on-chain program-version query. When the
    // owner can't pay (a governance/burn owner holds no SOL), the reader falls
    // back to FALLBACK_SIMULATION_PAYER — funded on mainnet but not on a local
    // validator, so fund it here so the read can simulate.
    await airdropSol(svmRpc, FALLBACK_SIMULATION_PAYER, 1_000_000_000n);

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [EVM_CHAIN, SVM_CHAIN]);
    const deployedConfig = await warpCommands.readConfig(
      SVM_CHAIN,
      warpCorePath,
    );
    const svmConfig = deployedConfig[SVM_CHAIN];

    // Ownership was handed to the configured (non-deployer) owner during
    // enrollment — the on-chain state confirms the override worked end to end.
    expect(svmConfig.owner).to.equal(svmOwner);
    // The EVM router was enrolled on the SVM warp, i.e. the post-create
    // enrollment ran successfully while the deployer still owned the warp.
    expect(Object.keys(svmConfig.remoteRouters ?? {}).length).to.be.greaterThan(
      0,
    );
  });
});
