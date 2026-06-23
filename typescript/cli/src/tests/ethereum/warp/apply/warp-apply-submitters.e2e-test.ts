import { expect } from 'chai';
import { type Signer, Wallet, ethers } from 'ethers';
import { existsSync, rmSync } from 'fs';

import {
  InterchainAccountRouter__factory,
  MockSafe__factory,
  type TimelockController,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type CallData,
  type ChainSubmissionStrategy,
  ChainSubmissionStrategySchema,
  type DerivedCoreConfig,
  type SubmissionStrategy,
  TokenType,
  TxSubmitterType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  type Domain,
  ProtocolType,
  assert,
  bytes32ToAddress,
} from '@hyperlane-xyz/utils';

import {
  CustomTxSubmitterType,
  type ExtendedChainSubmissionStrategy,
} from '../../../../submitters/types.js';
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
  JSON_RPC_ICA_STRATEGY_CONFIG_PATH,
  JSON_RPC_TIMELOCK_STRATEGY_CONFIG_PATH,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../../constants.js';
import { createMockSafeApi } from '../../commands/helpers.js';
import { WarpTestFixture } from '../../fixtures/warp-test-fixture.js';

describe('hyperlane warp apply with submitters', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const fixture = new WarpTestFixture({
    initialDeployConfig: {},
    deployConfigPath: DEFAULT_EVM_WARP_DEPLOY_PATH,
    coreConfigPath: DEFAULT_EVM_WARP_CORE_PATH,
  });

  let chain2Signer: Signer;
  let chain3Signer: Signer;
  let chain3Addresses: ChainAddresses = {};
  let chain2Addresses: ChainAddresses = {};
  let initialOwnerAddress: Address;
  let chain2DomainId: Domain;
  let chain3DomainId: Domain;
  let timelockInstance: TimelockController;
  let safeAddress: Address;
  let chain3IcaAddress: Address;
  const WARP_DEPLOY_CONFIG_PATH: string = DEFAULT_EVM_WARP_DEPLOY_PATH;
  const WARP_CORE_CONFIG_PATH: string = DEFAULT_EVM_WARP_CORE_PATH;
  const WARP_ROUTE_ID: string = DEFAULT_EVM_WARP_ID;
  const FORMATTED_TIMELOCK_SUBMITTER_STRATEGY_PATH = `${TEMP_PATH}/timelock-simple-strategy.yaml`;
  const SAFE_TX_BUILDER_SUBMITTER_STRATEGY_PATH = `${TEMP_PATH}/gnosis-safe-strategy.yaml`;
  const ICA_FILE_SUBMITTER_STRATEGY_PATH = `${TEMP_PATH}/ica-file-strategy.yaml`;
  const ICA_FILE_SUBMITTER_OUTPUT_PATH = `${TEMP_PATH}/ica-file-submitter-output.json`;
  const TIMELOCK_FILE_SUBMITTER_STRATEGY_PATH = `${TEMP_PATH}/timelock-file-strategy.yaml`;
  const TIMELOCK_FILE_SUBMITTER_OUTPUT_PATH = `${TEMP_PATH}/timelock-file-submitter-output.json`;
  const ICA_SAFE_FILE_SUBMITTER_STRATEGY_PATH = `${TEMP_PATH}/ica-safe-file-strategy.yaml`;
  const ICA_SAFE_FILE_SUBMITTER_OUTPUT_PATH = `${TEMP_PATH}/ica-safe-file-submitter-output.json`;
  const TIMELOCK_ICA_FILE_SUBMITTER_STRATEGY_PATH = `${TEMP_PATH}/timelock-ica-file-strategy.yaml`;
  const TIMELOCK_ICA_FILE_SUBMITTER_OUTPUT_PATH = `${TEMP_PATH}/timelock-ica-file-submitter-output.json`;

  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const evmChain3Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  );

  function formatTimelockStrategyFile(
    proposerSubmitter?: SubmissionStrategy['submitter'],
  ) {
    // Update the submitter config to use the deployed timelock address
    const timelockSubmitterConfig = ChainSubmissionStrategySchema.parse(
      readYamlOrJson(JSON_RPC_TIMELOCK_STRATEGY_CONFIG_PATH),
    );

    const chain3SubmissionStrategy =
      timelockSubmitterConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ];
    assert(
      chain3SubmissionStrategy.submitter.type ===
        TxSubmitterType.TIMELOCK_CONTROLLER,
      `expected submitter config to be of type ${TxSubmitterType.TIMELOCK_CONTROLLER}`,
    );

    chain3SubmissionStrategy.submitter.timelockAddress =
      timelockInstance.address;
    if (proposerSubmitter) {
      chain3SubmissionStrategy.submitter.proposerSubmitter = proposerSubmitter;
    }

    timelockSubmitterConfig[
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
    ] = chain3SubmissionStrategy;

    writeYamlOrJson(
      FORMATTED_TIMELOCK_SUBMITTER_STRATEGY_PATH,
      timelockSubmitterConfig,
    );
  }

  async function deployAndExportWarpRoute(): Promise<WarpRouteDeployConfig> {
    const warpDeployConfig = fixture.getDeployConfig();
    // currently warp deploy is not writing the deploy config to the registry
    // should remove this once the deploy config is written to the registry
    writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);
    await evmWarpCommands.deploy(
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );

    return warpDeployConfig;
  }

  // Reads the deployed synthetic warp token address on chain3 from the exported
  // warp core config, so payload-decoding assertions can check the inner call
  // actually targets the warp token rather than just any address.
  function getChain3WarpTokenAddress(): Address {
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH,
    );
    const chain3Token = warpCoreConfig.tokens.find(
      (token) =>
        token.chainName === TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
    );
    assert(
      chain3Token?.addressOrDenom,
      'expected a chain3 warp token address in the warp core config',
    );
    return chain3Token.addressOrDenom;
  }

  // Derives the chain3 interchain account owned by `owner` (origin chain2), used
  // to set the warp token owner so warp apply routes the update through the ICA.
  async function deriveChain3Ica(owner: Address): Promise<Address> {
    const chain2IcaRouter = InterchainAccountRouter__factory.connect(
      chain2Addresses.interchainAccountRouter,
      chain2Signer,
    );
    return chain2IcaRouter.callStatic[
      'getRemoteInterchainAccount(address,address,address)'
    ](
      owner,
      chain3Addresses.interchainAccountRouter,
      ethers.constants.AddressZero,
    );
  }

  before(async function () {
    const chain2Metadata =
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
    const chain3Metadata =
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3;

    const chain2Provider = new ethers.providers.JsonRpcProvider(
      chain2Metadata.rpcUrl,
    );
    const chain3Provider = new ethers.providers.JsonRpcProvider(
      chain3Metadata.rpcUrl,
    );
    chain2DomainId = chain2Metadata.domainId;
    chain3DomainId = chain3Metadata.domainId;
    const wallet = new Wallet(HYP_KEY_BY_PROTOCOL.ethereum);
    chain2Signer = wallet.connect(chain2Provider);

    chain3Signer = wallet.connect(chain3Provider);
    initialOwnerAddress = await chain2Signer.getAddress();

    [chain2Addresses, chain3Addresses] = await Promise.all([
      evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
      evmChain3Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum),
    ]);

    const chain2IcaRouter = InterchainAccountRouter__factory.connect(
      chain2Addresses.interchainAccountRouter,
      chain2Signer,
    );

    chain3IcaAddress = await chain2IcaRouter.callStatic[
      'getRemoteInterchainAccount(address,address,address)'
    ](
      initialOwnerAddress,
      chain3Addresses.interchainAccountRouter,
      ethers.constants.AddressZero,
    );

    // Deploy the timelock and set both the owner address and the ICA
    // as proposers and executors to avoid having to deploy a new timelock
    timelockInstance = await new TimelockController__factory()
      .connect(chain3Signer)
      .deploy(
        0,
        [initialOwnerAddress, chain3IcaAddress],
        [initialOwnerAddress, chain3IcaAddress],
        ethers.constants.AddressZero,
      );

    // Deploy a mock SAFE so that the SDK can check that a contract exists
    // at the provided address successfully
    const mockSafe = await new MockSafe__factory()
      .connect(chain3Signer)
      .deploy([initialOwnerAddress], 1);
    safeAddress = mockSafe.address;

    // Configure ICA connections by enrolling the ICAs with each other
    const [coreConfigChain2, coreConfigChain3]: DerivedCoreConfig[] =
      await Promise.all([
        evmChain2Core.readConfig(),
        evmChain3Core.readConfig(),
      ]);

    const coreConfigChain2IcaConfig = coreConfigChain2.interchainAccountRouter!;
    const coreConfigChain3IcaConfig = coreConfigChain3.interchainAccountRouter!;
    coreConfigChain2IcaConfig.remoteRouters = {
      [chain3DomainId]: {
        address: coreConfigChain3IcaConfig.address,
      },
    };

    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      coreConfigChain2,
    );
    await evmChain2Core.apply(HYP_KEY_BY_PROTOCOL.ethereum);

    // Set initial deploy config after addresses are available
    fixture.updateDeployConfig({
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.native,
        mailbox: chain2Addresses.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      },
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      },
    });
  });

  beforeEach(async function () {
    fixture.restoreConfigs();

    formatTimelockStrategyFile();
  });

  function getTimelockExecuteTxFile(logs: string): CallData {
    const maybeGeneratedTxFilePath = logs.match(
      /\.\/generated\/transactions\/anvil3-timelockController-\d+-receipts\.json/,
    );
    assert(maybeGeneratedTxFilePath, 'expected the tx file output');

    const [generatedTxFilePath] = maybeGeneratedTxFilePath;
    const txFile: CallData[] = readYamlOrJson(generatedTxFilePath);
    const executeTransaction = txFile.pop();
    assert(
      executeTransaction,
      'expected the timelock execute tx to be at the end of the receipts array',
    );

    return executeTransaction;
  }

  describe(TxSubmitterType.TIMELOCK_CONTROLLER, () => {
    it('should be able to propose transactions to a timelock contract and execute them', async () => {
      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].owner = timelockInstance.address;
      await deployAndExportWarpRoute();

      const expectedUpdatedGasValue = '900';
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].destinationGas = {
        [chain2DomainId]: expectedUpdatedGasValue,
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      const res = await evmWarpCommands.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        strategyUrl: FORMATTED_TIMELOCK_SUBMITTER_STRATEGY_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      // get the timelock output file from the logs
      const executeTransaction = getTimelockExecuteTxFile(res.text());

      const tx = await chain3Signer.sendTransaction(executeTransaction);
      await tx.wait();

      const updatedWarpDeployConfig_3_2 = await evmWarpCommands.readConfig(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        WARP_CORE_CONFIG_PATH,
      );

      expect(
        updatedWarpDeployConfig_3_2[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
        ].destinationGas![chain2DomainId],
      ).to.equal(expectedUpdatedGasValue);
    });

    it('should be able to propose transactions to a timelock contract using an ICA', async () => {
      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].owner = timelockInstance.address;
      await deployAndExportWarpRoute();

      // Set the timelock to use the ICA to propose txs
      formatTimelockStrategyFile({
        type: TxSubmitterType.INTERCHAIN_ACCOUNT,
        chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        destinationChain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        internalSubmitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        },
      });

      const expectedUpdatedGasValue = '900';
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].destinationGas = {
        [chain2DomainId]: expectedUpdatedGasValue,
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      const res = await evmWarpCommands.applyRaw({
        strategyUrl: FORMATTED_TIMELOCK_SUBMITTER_STRATEGY_PATH,
        warpRouteId: WARP_ROUTE_ID,
        relay: true,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      // get the timelock output file from the logs
      const executeTransaction = getTimelockExecuteTxFile(res.text());

      const tx = await chain3Signer.sendTransaction(executeTransaction);
      await tx.wait();

      const updatedWarpDeployConfig_3_2 = await evmWarpCommands.readConfig(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        WARP_CORE_CONFIG_PATH,
      );

      expect(
        updatedWarpDeployConfig_3_2[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
        ].destinationGas![chain2DomainId],
      ).to.equal(expectedUpdatedGasValue);
    });

    it('should write the timelock proposal to a file when the proposerSubmitter is a file submitter', async () => {
      if (existsSync(TIMELOCK_FILE_SUBMITTER_OUTPUT_PATH)) {
        rmSync(TIMELOCK_FILE_SUBMITTER_OUTPUT_PATH);
      }

      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].owner = timelockInstance.address;
      await deployAndExportWarpRoute();

      const timelockFileStrategy: ExtendedChainSubmissionStrategy = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          submitter: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
            timelockAddress: timelockInstance.address,
            // The CLI-only `file` submitter nested as the timelock's proposer.
            proposerSubmitter: {
              type: CustomTxSubmitterType.FILE,
              chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
              filepath: TIMELOCK_FILE_SUBMITTER_OUTPUT_PATH,
            },
          },
        },
      };
      writeYamlOrJson(
        TIMELOCK_FILE_SUBMITTER_STRATEGY_PATH,
        timelockFileStrategy,
      );

      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].destinationGas = {
        [chain2DomainId]: '900',
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      const res = await evmWarpCommands.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        strategyUrl: TIMELOCK_FILE_SUBMITTER_STRATEGY_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      expect(res.text()).not.to.include(
        'Error in submitWarpApplyTransactions Error:',
      );

      // The propose tx must have been written to the file by the file submitter.
      const proposeTxs: CallData[] = readYamlOrJson(
        TIMELOCK_FILE_SUBMITTER_OUTPUT_PATH,
      );
      expect(proposeTxs).to.be.an('array').with.lengthOf(1);
      const [proposeTx] = proposeTxs;
      // scheduleBatch is called on the timelock contract itself.
      expect(proposeTx.to.toLowerCase()).to.equal(
        timelockInstance.address.toLowerCase(),
      );
      expect(proposeTx.data).to.be.a('string').that.is.not.empty;

      // Decode the payload: it must be a scheduleBatch whose single inner
      // target is the chain3 warp token being updated.
      const decoded =
        TimelockController__factory.createInterface().parseTransaction({
          data: proposeTx.data,
        });
      expect(decoded.name).to.equal('scheduleBatch');
      const [targets] = decoded.args;
      expect(targets).to.have.lengthOf(1);
      expect(targets[0].toLowerCase()).to.equal(
        getChain3WarpTokenAddress().toLowerCase(),
      );
    });

    it('should thread the file submitter through a timelock -> ICA -> file composite (depth 2)', async () => {
      if (existsSync(TIMELOCK_ICA_FILE_SUBMITTER_OUTPUT_PATH)) {
        rmSync(TIMELOCK_ICA_FILE_SUBMITTER_OUTPUT_PATH);
      }

      // Own the warp token with the timelock; the timelock's proposer is the
      // chain3 ICA (owned by the deployer), which itself writes to a file. This
      // exercises the custom `file` factory at recursion depth 2 — the exact
      // case the threading fix protects.
      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].owner = timelockInstance.address;
      await deployAndExportWarpRoute();

      const timelockIcaFileStrategy: ExtendedChainSubmissionStrategy = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          submitter: {
            type: TxSubmitterType.TIMELOCK_CONTROLLER,
            chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
            timelockAddress: timelockInstance.address,
            proposerSubmitter: {
              type: TxSubmitterType.INTERCHAIN_ACCOUNT,
              chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
              destinationChain:
                TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
              owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
              internalSubmitter: {
                type: CustomTxSubmitterType.FILE,
                chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
                filepath: TIMELOCK_ICA_FILE_SUBMITTER_OUTPUT_PATH,
              },
            },
          },
        },
      };
      writeYamlOrJson(
        TIMELOCK_ICA_FILE_SUBMITTER_STRATEGY_PATH,
        timelockIcaFileStrategy,
      );

      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].destinationGas = {
        [chain2DomainId]: '900',
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      const res = await evmWarpCommands.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        strategyUrl: TIMELOCK_ICA_FILE_SUBMITTER_STRATEGY_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      expect(res.text()).not.to.include(
        'Error in submitWarpApplyTransactions Error:',
      );

      // The depth-2 file submitter must have written the ICA callRemote that
      // wraps the timelock scheduleBatch.
      const callRemoteTxs: Array<CallData & { from: string }> = readYamlOrJson(
        TIMELOCK_ICA_FILE_SUBMITTER_OUTPUT_PATH,
      );
      expect(callRemoteTxs).to.be.an('array').with.lengthOf(1);
      const [callRemoteTx] = callRemoteTxs;
      // callRemote is sent to the origin-chain InterchainAccountRouter and the
      // self-describing `from` is the ICA owner (the deployer).
      expect(callRemoteTx.to.toLowerCase()).to.equal(
        chain2Addresses.interchainAccountRouter.toLowerCase(),
      );
      expect(callRemoteTx.from.toLowerCase()).to.equal(
        HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum.toLowerCase(),
      );

      // The ICA inner call targets the timelock (scheduleBatch), whose own inner
      // target is the chain3 warp token.
      const decodedCallRemote =
        InterchainAccountRouter__factory.createInterface().parseTransaction({
          data: callRemoteTx.data,
        });
      expect(decodedCallRemote.name).to.equal('callRemoteWithOverrides');
      const icaInnerCalls = decodedCallRemote.args[3];
      expect(icaInnerCalls).to.have.lengthOf(1);
      expect(bytes32ToAddress(icaInnerCalls[0].to).toLowerCase()).to.equal(
        timelockInstance.address.toLowerCase(),
      );

      const decodedSchedule =
        TimelockController__factory.createInterface().parseTransaction({
          data: icaInnerCalls[0].data,
        });
      expect(decodedSchedule.name).to.equal('scheduleBatch');
      const [scheduleTargets] = decodedSchedule.args;
      expect(scheduleTargets).to.have.lengthOf(1);
      expect(scheduleTargets[0].toLowerCase()).to.equal(
        getChain3WarpTokenAddress().toLowerCase(),
      );
    });
  });

  describe(TxSubmitterType.INTERCHAIN_ACCOUNT, () => {
    it('should relay the ICA transaction to update the warp on the destination chain', async () => {
      // Transfer ownership of the warp token on chain3 to the ICA account
      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].owner = chain3IcaAddress;
      await deployAndExportWarpRoute();

      // Update the remote gas for chain2 on chain3 and run warp apply with an ICA strategy
      const expectedChain2Gas = '46000';
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].destinationGas = {
        [chain2DomainId]: expectedChain2Gas,
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      await evmWarpCommands.applyRaw({
        strategyUrl: JSON_RPC_ICA_STRATEGY_CONFIG_PATH,
        warpRouteId: WARP_ROUTE_ID,
        relay: true,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      const updatedWarpDeployConfig_3_2 = await evmWarpCommands.readConfig(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        WARP_CORE_CONFIG_PATH,
      );

      expect(
        updatedWarpDeployConfig_3_2[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
        ].destinationGas![chain2DomainId],
      ).to.equal(expectedChain2Gas);
    });

    it('should write the ICA callRemote to a file when the internalSubmitter is a file submitter', async () => {
      if (existsSync(ICA_FILE_SUBMITTER_OUTPUT_PATH)) {
        rmSync(ICA_FILE_SUBMITTER_OUTPUT_PATH);
      }

      // Transfer ownership of the warp token on chain3 to the ICA account so
      // that warp apply routes the update through the ICA submitter.
      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].owner = chain3IcaAddress;
      await deployAndExportWarpRoute();

      const icaFileStrategy: ExtendedChainSubmissionStrategy = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          submitter: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
            destinationChain:
              TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
            owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
            // The CLI-only `file` submitter nested as the ICA's internal submitter.
            internalSubmitter: {
              type: CustomTxSubmitterType.FILE,
              chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
              filepath: ICA_FILE_SUBMITTER_OUTPUT_PATH,
            },
          },
        },
      };
      writeYamlOrJson(ICA_FILE_SUBMITTER_STRATEGY_PATH, icaFileStrategy);

      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].destinationGas = {
        [chain2DomainId]: '46000',
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      const res = await evmWarpCommands.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        strategyUrl: ICA_FILE_SUBMITTER_STRATEGY_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      expect(res.text()).not.to.include(
        'Error in submitWarpApplyTransactions Error:',
      );

      // The ICA collapses the warp update into a single callRemote, which the
      // file submitter must write to the output file.
      const callRemoteTxs: Array<CallData & { from: string }> = readYamlOrJson(
        ICA_FILE_SUBMITTER_OUTPUT_PATH,
      );
      expect(callRemoteTxs).to.be.an('array').with.lengthOf(1);
      const [callRemoteTx] = callRemoteTxs;
      // callRemote is sent to the origin-chain InterchainAccountRouter.
      expect(callRemoteTx.to.toLowerCase()).to.equal(
        chain2Addresses.interchainAccountRouter.toLowerCase(),
      );
      expect(callRemoteTx.data).to.be.a('string').that.is.not.empty;

      // `from` must be the configured ICA owner (here the deployer), not the
      // signer that populated the tx — callRemote derives the ICA from msg.sender.
      expect(callRemoteTx.from.toLowerCase()).to.equal(
        HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum.toLowerCase(),
      );

      // Decode the payload: it must be a callRemoteWithOverrides whose single
      // inner call targets the chain3 warp token.
      const decoded =
        InterchainAccountRouter__factory.createInterface().parseTransaction({
          data: callRemoteTx.data,
        });
      expect(decoded.name).to.equal('callRemoteWithOverrides');
      const innerCalls = decoded.args[3];
      expect(innerCalls).to.have.lengthOf(1);
      expect(bytes32ToAddress(innerCalls[0].to).toLowerCase()).to.equal(
        getChain3WarpTokenAddress().toLowerCase(),
      );
    });

    it('should write a callRemote with `from` set to a Safe owner when the ICA owner is a multisig', async () => {
      if (existsSync(ICA_SAFE_FILE_SUBMITTER_OUTPUT_PATH)) {
        rmSync(ICA_SAFE_FILE_SUBMITTER_OUTPUT_PATH);
      }

      // Own the warp token with the ICA derived from the Safe so warp apply
      // routes the update through the (Safe-owned) ICA submitter.
      const safeIcaAddress = await deriveChain3Ica(safeAddress);
      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].owner = safeIcaAddress;
      await deployAndExportWarpRoute();

      const icaSafeFileStrategy: ExtendedChainSubmissionStrategy = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          submitter: {
            type: TxSubmitterType.INTERCHAIN_ACCOUNT,
            chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
            destinationChain:
              TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
            owner: safeAddress,
            internalSubmitter: {
              type: CustomTxSubmitterType.FILE,
              chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
              filepath: ICA_SAFE_FILE_SUBMITTER_OUTPUT_PATH,
            },
          },
        },
      };
      writeYamlOrJson(
        ICA_SAFE_FILE_SUBMITTER_STRATEGY_PATH,
        icaSafeFileStrategy,
      );

      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].destinationGas = {
        [chain2DomainId]: '46000',
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      const res = await evmWarpCommands.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        strategyUrl: ICA_SAFE_FILE_SUBMITTER_STRATEGY_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      expect(res.text()).not.to.include(
        'Error in submitWarpApplyTransactions Error:',
      );

      const callRemoteTxs: Array<CallData & { from: string }> = readYamlOrJson(
        ICA_SAFE_FILE_SUBMITTER_OUTPUT_PATH,
      );
      expect(callRemoteTxs).to.be.an('array').with.lengthOf(1);
      const [callRemoteTx] = callRemoteTxs;
      // The self-describing `from` must be the Safe, not the deployer signer.
      expect(callRemoteTx.from.toLowerCase()).to.equal(
        safeAddress.toLowerCase(),
      );
      expect(callRemoteTx.from.toLowerCase()).to.not.equal(
        HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum.toLowerCase(),
      );
    });
  });

  describe(`${TxSubmitterType.GNOSIS_TX_BUILDER}/${TxSubmitterType.GNOSIS_SAFE}`, () => {
    let mockSafeApiServer: Awaited<ReturnType<typeof createMockSafeApi>>;

    before(async function () {
      mockSafeApiServer = await createMockSafeApi(
        TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        safeAddress,
        initialOwnerAddress,
        5,
      );
    });

    after(async function () {
      await mockSafeApiServer.close();
    });

    it('should propose the transaction file to the Safe API', async () => {
      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].owner = safeAddress;
      await deployAndExportWarpRoute();

      const txBuilderStrategy: ChainSubmissionStrategy = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          submitter: {
            type: TxSubmitterType.GNOSIS_SAFE,
            chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
            safeAddress: safeAddress,
          },
        },
      };

      writeYamlOrJson(
        SAFE_TX_BUILDER_SUBMITTER_STRATEGY_PATH,
        txBuilderStrategy,
      );

      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].destinationGas = {
        [chain2DomainId]: '100000',
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      const output = await evmWarpCommands.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        strategyUrl: SAFE_TX_BUILDER_SUBMITTER_STRATEGY_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      expect(output.text()).not.to.include(
        'Error in submitWarpApplyTransactions Error:',
      );
    });

    it('should generate the JSON transaction file to be submitted to the Safe Transaction Builder', async () => {
      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].owner = safeAddress;
      await deployAndExportWarpRoute();

      const txBuilderStrategy: ChainSubmissionStrategy = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          submitter: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
            safeAddress: safeAddress,
            version: '1.0',
          },
        },
      };

      writeYamlOrJson(
        SAFE_TX_BUILDER_SUBMITTER_STRATEGY_PATH,
        txBuilderStrategy,
      );

      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3
      ].destinationGas = {
        [chain2DomainId]: '100000',
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      const result = await evmWarpCommands.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        strategyUrl: SAFE_TX_BUILDER_SUBMITTER_STRATEGY_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      // Extract the combined bundle file path from the logs
      const output = result.text();
      const filePathMatch = output.match(
        /Combined \d+ bundle\(s\).*written to (.*\.json)/,
      );
      assert(filePathMatch, 'Expected combined bundle file path in output');
      const [, filePath] = filePathMatch;

      // Read the exported JSON file
      const txBuilderJson: {
        version: string;
        chainId: string;
        transactions: { to: string; data: string }[];
      } = readYamlOrJson(filePath);

      // Verify Safe Transaction Builder JSON format
      expect(txBuilderJson).to.have.property('version', '1.0');
      expect(txBuilderJson).to.have.property('chainId');
      expect(txBuilderJson).to.have.property('transactions');
      expect(txBuilderJson.transactions).to.be.an('array');
      expect(txBuilderJson.transactions.length).to.equal(1);
    });
  });
});
