import { expect } from 'chai';
import { Wallet } from 'ethers';
import { type StartedTestContainer } from 'testcontainers';
import { $ } from 'zx';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  TokenFeeType,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import {
  FALLBACK_SIMULATION_PAYER,
  SealevelSigner,
  createRpc,
} from '@hyperlane-xyz/sealevel-sdk';
import {
  type SolanaTestValidator,
  airdropSol,
  getPreloadedPrograms,
  runSolanaNode,
} from '@hyperlane-xyz/sealevel-sdk/testing';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
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
import { deployToken } from '../../ethereum/commands/helpers.js';
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
    svmSigner = await SealevelSigner.connectWithSigner(
      TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      SVM_KEY,
    );
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
