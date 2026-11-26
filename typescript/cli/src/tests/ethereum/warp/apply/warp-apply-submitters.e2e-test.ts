import { expect } from 'chai';
import { BigNumber, type Signer, Wallet, ethers } from 'ethers';
import { existsSync, readdirSync, rmSync } from 'fs';

import {
  GasRouter__factory,
  type IAccessManager,
  IAccessManager__factory,
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
  TokenFeeType,
  TokenType,
  TxSubmitterType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
  deployTestAccessManager,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  type Domain,
  ProtocolType,
  assert,
  bytes32ToAddress,
  eqAddress,
} from '@hyperlane-xyz/utils';

import {
  CustomTxSubmitterType,
  type ExtendedChainSubmissionStrategy,
  type ExtendedSubmissionStrategy,
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
import {
  createMockSafeApi,
  hyperlaneStatus,
  hyperlaneSubmit,
  increaseEvmTime,
} from '../../commands/helpers.js';
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
  const FEE_BUCKET_MERGED_STRATEGY_PATH = `${TEMP_PATH}/fee-bucket-merged-strategy.yaml`;
  const FEE_BUCKET_MERGED_OUTPUT_PATH = `${TEMP_PATH}/fee-bucket-merged-output.json`;
  const FEE_BUCKET_SPLIT_STRATEGY_PATH = `${TEMP_PATH}/fee-bucket-split-strategy.yaml`;
  const FEE_BUCKET_SPLIT_MAIN_OUTPUT_PATH = `${TEMP_PATH}/fee-bucket-split-main-output.json`;
  const FEE_BUCKET_SPLIT_FEE_OUTPUT_PATH = `${TEMP_PATH}/fee-bucket-split-fee-output.json`;
  const ACCESS_MANAGER_STRATEGY_PATH = `${TEMP_PATH}/access-manager-strategy.yaml`;
  const ACCESS_MANAGER_FILE_SUBMITTER_OUTPUT_PATH = `${TEMP_PATH}/access-manager-file-submitter-output.json`;
  const ACCESS_MANAGER_EXECUTE_TXS_PATH = `${TEMP_PATH}/access-manager-execute-txs.json`;
  const ACCESS_MANAGER_SUBMIT_RECEIPTS_DIR = `${TEMP_PATH}/access-manager-submit-receipts`;

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

  const accessManagerInterface = IAccessManager__factory.createInterface();

  // A deferred AccessManager execute tx as written to a JSON output file
  type SerializedExecuteTx = {
    to: Address;
    data: string;
    chainId: number;
    from?: Address;
    value?: string;
  };

  function isSerializedExecuteTx(value: unknown): value is SerializedExecuteTx {
    return (
      typeof value === 'object' &&
      value !== null &&
      !('transactionHash' in value) &&
      'to' in value &&
      typeof value.to === 'string' &&
      'data' in value &&
      typeof value.data === 'string' &&
      'chainId' in value &&
      typeof value.chainId === 'number' &&
      (!('value' in value) || typeof value.value === 'string')
    );
  }

  function toTxRequest(
    tx: SerializedExecuteTx,
  ): ethers.providers.TransactionRequest {
    return {
      to: tx.to,
      from: tx.from,
      data: tx.data,
      chainId: tx.chainId,
      value: tx.value ? BigNumber.from(tx.value) : undefined,
    };
  }

  function getReceiptsFilePath(
    logs: string,
    submitterType: TxSubmitterType,
  ): string {
    const match = logs.match(
      new RegExp(
        `\\./generated/transactions/${TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3}-${submitterType}-\\d+-receipts\\.json`,
      ),
    );
    assert(match, `expected the ${submitterType} receipts file output`);
    return match[0];
  }

  function readDeferredExecuteTxs(
    logs: string,
    submitterType: TxSubmitterType,
  ): SerializedExecuteTx[] {
    const output: unknown = readYamlOrJson(
      getReceiptsFilePath(logs, submitterType),
    );
    assert(Array.isArray(output), 'expected an array of receipts');
    return output.filter(isSerializedExecuteTx);
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

    // Clear any file-submitter output from a previous test so each test asserts
    // against freshly written transactions.
    for (const outputPath of [
      ICA_FILE_SUBMITTER_OUTPUT_PATH,
      TIMELOCK_FILE_SUBMITTER_OUTPUT_PATH,
      ICA_SAFE_FILE_SUBMITTER_OUTPUT_PATH,
      TIMELOCK_ICA_FILE_SUBMITTER_OUTPUT_PATH,
      FEE_BUCKET_MERGED_OUTPUT_PATH,
      FEE_BUCKET_SPLIT_MAIN_OUTPUT_PATH,
      FEE_BUCKET_SPLIT_FEE_OUTPUT_PATH,
      ACCESS_MANAGER_FILE_SUBMITTER_OUTPUT_PATH,
      ACCESS_MANAGER_EXECUTE_TXS_PATH,
    ]) {
      if (existsSync(outputPath)) {
        rmSync(outputPath);
      }
    }
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
      expect(eqAddress(proposeTx.to, timelockInstance.address)).to.be.true;
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
      expect(eqAddress(targets[0], getChain3WarpTokenAddress())).to.be.true;
    });

    it('should thread the file submitter through a timelock -> ICA -> file composite (depth 2)', async () => {
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
      expect(
        eqAddress(callRemoteTx.to, chain2Addresses.interchainAccountRouter),
      ).to.be.true;
      expect(
        eqAddress(callRemoteTx.from, HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum),
      ).to.be.true;

      // The ICA inner call targets the timelock (scheduleBatch), whose own inner
      // target is the chain3 warp token.
      const decodedCallRemote =
        InterchainAccountRouter__factory.createInterface().parseTransaction({
          data: callRemoteTx.data,
        });
      expect(decodedCallRemote.name).to.equal('callRemoteWithOverrides');
      const icaInnerCalls = decodedCallRemote.args[3];
      expect(icaInnerCalls).to.have.lengthOf(1);
      expect(
        eqAddress(
          bytes32ToAddress(icaInnerCalls[0].to),
          timelockInstance.address,
        ),
      ).to.be.true;

      const decodedSchedule =
        TimelockController__factory.createInterface().parseTransaction({
          data: icaInnerCalls[0].data,
        });
      expect(decodedSchedule.name).to.equal('scheduleBatch');
      const [scheduleTargets] = decodedSchedule.args;
      expect(scheduleTargets).to.have.lengthOf(1);
      expect(eqAddress(scheduleTargets[0], getChain3WarpTokenAddress())).to.be
        .true;
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
      expect(
        eqAddress(callRemoteTx.to, chain2Addresses.interchainAccountRouter),
      ).to.be.true;
      expect(callRemoteTx.data).to.be.a('string').that.is.not.empty;

      // `from` must be the configured ICA owner (here the deployer), not the
      // signer that populated the tx — callRemote derives the ICA from msg.sender.
      expect(
        eqAddress(callRemoteTx.from, HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum),
      ).to.be.true;

      // Decode the payload: it must be a callRemoteWithOverrides whose single
      // inner call targets the chain3 warp token.
      const decoded =
        InterchainAccountRouter__factory.createInterface().parseTransaction({
          data: callRemoteTx.data,
        });
      expect(decoded.name).to.equal('callRemoteWithOverrides');
      const innerCalls = decoded.args[3];
      expect(innerCalls).to.have.lengthOf(1);
      expect(
        eqAddress(
          bytes32ToAddress(innerCalls[0].to),
          getChain3WarpTokenAddress(),
        ),
      ).to.be.true;
    });

    it('should write a callRemote with `from` set to a Safe owner when the ICA owner is a multisig', async () => {
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
      expect(eqAddress(callRemoteTx.from, safeAddress)).to.be.true;
      expect(
        eqAddress(callRemoteTx.from, HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum),
      ).to.be.false;
    });
  });

  describe(TxSubmitterType.ACCESS_MANAGER, () => {
    const CHAIN_2 = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
    const CHAIN_3 = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3;
    const ACCESS_MANAGER_ROLE = 1;
    const IMMEDIATE_ACCESS_MANAGER_ROLE = 2;
    const EXECUTION_DELAY = 3600;
    const setDestinationGasSelector =
      GasRouter__factory.createInterface().getSighash(
        'setDestinationGas((uint32,uint256)[])',
      );
    const transferOwnershipSelector =
      GasRouter__factory.createInterface().getSighash(
        'transferOwnership(address)',
      );
    const callRemoteWithOverridesSelector =
      InterchainAccountRouter__factory.createInterface().getSighash(
        'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes)',
      );

    async function grantAccess({
      accessManager,
      target,
      selector,
      account,
      executionDelay,
      role = ACCESS_MANAGER_ROLE,
    }: {
      accessManager: IAccessManager;
      target: Address;
      selector: string;
      account: Address;
      executionDelay: number;
      role?: number;
    }): Promise<void> {
      await (
        await accessManager.setTargetFunctionRole(target, [selector], role)
      ).wait();
      await (
        await accessManager.grantRole(role, account, executionDelay)
      ).wait();
    }

    async function deployAccessManagerOwnedWarpRoute(): Promise<{
      accessManager: IAccessManager;
      warpDeployConfig: WarpRouteDeployConfig;
    }> {
      const accessManager = await deployTestAccessManager(
        chain3Signer,
        initialOwnerAddress,
      );
      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[CHAIN_3].owner = accessManager.address;
      await deployAndExportWarpRoute();
      return { accessManager, warpDeployConfig };
    }

    function writeAccessManagerStrategy(
      submitter: ExtendedSubmissionStrategy['submitter'],
    ): void {
      const strategy: ExtendedChainSubmissionStrategy = {
        [CHAIN_3]: { submitter },
      };
      writeYamlOrJson(ACCESS_MANAGER_STRATEGY_PATH, strategy);
    }

    function stageDestinationGasUpdate(
      warpDeployConfig: WarpRouteDeployConfig,
      gas: string,
    ): void {
      warpDeployConfig[CHAIN_3].destinationGas = { [chain2DomainId]: gas };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);
    }

    async function readChain3DestinationGas(): Promise<string | undefined> {
      const config = await evmWarpCommands.readConfig(
        CHAIN_3,
        WARP_CORE_CONFIG_PATH,
      );
      return config[CHAIN_3].destinationGas?.[chain2DomainId];
    }

    function expectScheduledDestinationGasUpdate(data: string): void {
      const decoded = accessManagerInterface.parseTransaction({ data });
      expect(decoded.name).to.equal('schedule');
      const [target, targetData, when] = decoded.args;
      expect(eqAddress(target, getChain3WarpTokenAddress())).to.be.true;
      expect(targetData.startsWith(setDestinationGasSelector)).to.be.true;
      expect(when).to.equal(0);
    }

    function applyWithAccessManagerStrategy(relay?: boolean) {
      return evmWarpCommands.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        strategyUrl: ACCESS_MANAGER_STRATEGY_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
        relay,
      });
    }

    it('should schedule delayed calls and execute them after the delay', async () => {
      const { accessManager, warpDeployConfig } =
        await deployAccessManagerOwnedWarpRoute();
      await grantAccess({
        accessManager,
        target: getChain3WarpTokenAddress(),
        selector: setDestinationGasSelector,
        account: initialOwnerAddress,
        executionDelay: EXECUTION_DELAY,
      });
      writeAccessManagerStrategy({
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_3,
        accessManagerAddress: accessManager.address,
        caller: initialOwnerAddress,
        proposerSubmitter: { type: TxSubmitterType.JSON_RPC, chain: CHAIN_3 },
      });
      const expectedGas = '901';
      stageDestinationGasUpdate(warpDeployConfig, expectedGas);

      const res = await applyWithAccessManagerStrategy();

      expect(res.exitCode).to.equal(0);
      expect(await readChain3DestinationGas()).to.not.equal(expectedGas);
      const executeTxs = readDeferredExecuteTxs(
        res.text(),
        TxSubmitterType.ACCESS_MANAGER,
      );
      expect(executeTxs).to.have.lengthOf(1);
      const [executeTx] = executeTxs;
      expect(eqAddress(executeTx.to, accessManager.address)).to.be.true;
      const decodedExecute = accessManagerInterface.parseTransaction({
        data: executeTx.data,
      });
      expect(decodedExecute.name).to.equal('execute');
      expect(eqAddress(decodedExecute.args[0], getChain3WarpTokenAddress())).to
        .be.true;

      await increaseEvmTime(
        TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3.rpcUrl,
        EXECUTION_DELAY,
      );
      await (await chain3Signer.sendTransaction(toTxRequest(executeTx))).wait();

      expect(await readChain3DestinationGas()).to.equal(expectedGas);
    });

    it('should defer an immediate ownership transfer behind a scheduled main-batch call', async () => {
      const { accessManager, warpDeployConfig } =
        await deployAccessManagerOwnedWarpRoute();
      const warpToken = getChain3WarpTokenAddress();
      await grantAccess({
        accessManager,
        target: warpToken,
        selector: setDestinationGasSelector,
        account: initialOwnerAddress,
        executionDelay: EXECUTION_DELAY,
      });
      await grantAccess({
        accessManager,
        target: warpToken,
        selector: transferOwnershipSelector,
        account: initialOwnerAddress,
        executionDelay: 0,
        role: IMMEDIATE_ACCESS_MANAGER_ROLE,
      });
      writeAccessManagerStrategy({
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_3,
        accessManagerAddress: accessManager.address,
        caller: initialOwnerAddress,
        proposerSubmitter: { type: TxSubmitterType.JSON_RPC, chain: CHAIN_3 },
      });
      const newOwner = Wallet.createRandom().address;
      warpDeployConfig[CHAIN_3].owner = newOwner;
      // Keep the ProxyAdmin owner so the token transfer is the only ownership tx
      warpDeployConfig[CHAIN_3].proxyAdmin = { owner: accessManager.address };
      const expectedGas = '905';
      stageDestinationGasUpdate(warpDeployConfig, expectedGas);

      const res = await applyWithAccessManagerStrategy();

      expect(res.exitCode).to.equal(0);
      const mainOutput: unknown = readYamlOrJson(
        getReceiptsFilePath(res.text(), TxSubmitterType.ACCESS_MANAGER),
      );
      assert(Array.isArray(mainOutput), 'expected an array of receipts');
      expect(mainOutput).to.have.lengthOf(2);
      const [mainExecuteTx] = mainOutput.filter(isSerializedExecuteTx);
      assert(mainExecuteTx, 'expected a deferred main-batch execute tx');
      const decodedMainExecute = accessManagerInterface.parseTransaction({
        data: mainExecuteTx.data,
      });
      expect(decodedMainExecute.name).to.equal('execute');
      expect(decodedMainExecute.args[1].startsWith(setDestinationGasSelector))
        .to.be.true;

      const ownershipPathMatch = res
        .text()
        .match(
          new RegExp(
            `\\./generated/transactions/${CHAIN_3}-ownership-\\d+-receipts\\.json`,
          ),
        );
      assert(ownershipPathMatch, 'expected the ownership receipts file output');
      const ownershipOutput: unknown = readYamlOrJson(ownershipPathMatch[0]);
      assert(Array.isArray(ownershipOutput), 'expected an array of receipts');
      expect(ownershipOutput).to.have.lengthOf(1);
      const [ownershipExecuteTx] = ownershipOutput.filter(
        isSerializedExecuteTx,
      );
      assert(ownershipExecuteTx, 'expected a deferred ownership execute tx');
      const decodedOwnershipExecute = accessManagerInterface.parseTransaction({
        data: ownershipExecuteTx.data,
      });
      expect(decodedOwnershipExecute.name).to.equal('execute');
      expect(eqAddress(decodedOwnershipExecute.args[0], warpToken)).to.be.true;
      expect(
        decodedOwnershipExecute.args[1].startsWith(transferOwnershipSelector),
      ).to.be.true;

      const configBefore = await evmWarpCommands.readConfig(
        CHAIN_3,
        WARP_CORE_CONFIG_PATH,
      );
      expect(eqAddress(configBefore[CHAIN_3].owner, accessManager.address)).to
        .be.true;
      expect(
        configBefore[CHAIN_3].destinationGas?.[chain2DomainId],
      ).to.not.equal(expectedGas);

      await increaseEvmTime(
        TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3.rpcUrl,
        EXECUTION_DELAY,
      );
      for (const executeTx of [mainExecuteTx, ownershipExecuteTx]) {
        await (
          await chain3Signer.sendTransaction(toTxRequest(executeTx))
        ).wait();
      }

      const configAfter = await evmWarpCommands.readConfig(
        CHAIN_3,
        WARP_CORE_CONFIG_PATH,
      );
      expect(configAfter[CHAIN_3].destinationGas?.[chain2DomainId]).to.equal(
        expectedGas,
      );
      expect(eqAddress(configAfter[CHAIN_3].owner, newOwner)).to.be.true;
    });

    it('should execute immediately permitted calls right away', async () => {
      const { accessManager, warpDeployConfig } =
        await deployAccessManagerOwnedWarpRoute();
      await grantAccess({
        accessManager,
        target: getChain3WarpTokenAddress(),
        selector: setDestinationGasSelector,
        account: initialOwnerAddress,
        executionDelay: 0,
      });
      writeAccessManagerStrategy({
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_3,
        accessManagerAddress: accessManager.address,
        caller: initialOwnerAddress,
        proposerSubmitter: { type: TxSubmitterType.JSON_RPC, chain: CHAIN_3 },
      });
      const expectedGas = '902';
      stageDestinationGasUpdate(warpDeployConfig, expectedGas);

      const res = await applyWithAccessManagerStrategy();

      expect(res.exitCode).to.equal(0);
      expect(await readChain3DestinationGas()).to.equal(expectedGas);
      expect(
        readDeferredExecuteTxs(res.text(), TxSubmitterType.ACCESS_MANAGER),
      ).to.have.lengthOf(0);
    });

    it('should write the schedule txs to a file when the proposerSubmitter is a file submitter', async () => {
      const { accessManager, warpDeployConfig } =
        await deployAccessManagerOwnedWarpRoute();
      writeAccessManagerStrategy({
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_3,
        accessManagerAddress: accessManager.address,
        proposerSubmitter: {
          type: CustomTxSubmitterType.FILE,
          chain: CHAIN_3,
          filepath: ACCESS_MANAGER_FILE_SUBMITTER_OUTPUT_PATH,
        },
      });
      const expectedGas = '903';
      stageDestinationGasUpdate(warpDeployConfig, expectedGas);

      const res = await applyWithAccessManagerStrategy();

      expect(res.exitCode).to.equal(0);
      const scheduleTxs: CallData[] = readYamlOrJson(
        ACCESS_MANAGER_FILE_SUBMITTER_OUTPUT_PATH,
      );
      expect(scheduleTxs).to.be.an('array').with.lengthOf(1);
      const [scheduleTx] = scheduleTxs;
      expect(eqAddress(scheduleTx.to, accessManager.address)).to.be.true;
      expectScheduledDestinationGasUpdate(scheduleTx.data);

      const executeTxs = readDeferredExecuteTxs(
        res.text(),
        TxSubmitterType.ACCESS_MANAGER,
      );
      expect(executeTxs).to.have.lengthOf(1);
      expect(executeTxs[0].from).to.be.undefined;
      expect(await readChain3DestinationGas()).to.not.equal(expectedGas);
    });

    describe(`with a ${TxSubmitterType.GNOSIS_TX_BUILDER} proposer`, () => {
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

      it('should wrap the schedule txs in the Safe Transaction Builder payload', async () => {
        const { accessManager, warpDeployConfig } =
          await deployAccessManagerOwnedWarpRoute();
        writeAccessManagerStrategy({
          type: TxSubmitterType.ACCESS_MANAGER,
          chain: CHAIN_3,
          accessManagerAddress: accessManager.address,
          proposerSubmitter: {
            type: TxSubmitterType.GNOSIS_TX_BUILDER,
            chain: CHAIN_3,
            safeAddress,
            version: '1.0',
          },
        });
        stageDestinationGasUpdate(warpDeployConfig, '904');

        const res = await applyWithAccessManagerStrategy();

        expect(res.exitCode).to.equal(0);
        const bundlePathMatch = res
          .text()
          .match(/Combined 1 bundle\(s\) \(1 txs\).*written to (.*\.json)/);
        assert(bundlePathMatch, 'Expected combined bundle file path in output');
        expect(bundlePathMatch[1]).to.include(
          `-safe${safeAddress.slice(0, 8)}-`,
        );
        const bundle: {
          version: string;
          transactions: Array<{ to: string; data: string }>;
        } = readYamlOrJson(bundlePathMatch[1]);
        expect(bundle.version).to.equal('1.0');
        expect(bundle.transactions).to.have.lengthOf(1);
        const [scheduleTx] = bundle.transactions;
        expect(eqAddress(scheduleTx.to, accessManager.address)).to.be.true;
        expectScheduledDestinationGasUpdate(scheduleTx.data);

        const receipts: unknown = readYamlOrJson(
          getReceiptsFilePath(res.text(), TxSubmitterType.ACCESS_MANAGER),
        );
        assert(Array.isArray(receipts), 'expected an array of receipts');
        expect(receipts).to.have.lengthOf(1);
        const executeTxs = receipts.filter(isSerializedExecuteTx);
        expect(executeTxs).to.have.lengthOf(1);
        const [executeTx] = executeTxs;
        expect(eqAddress(executeTx.to, accessManager.address)).to.be.true;
        const decodedExecute = accessManagerInterface.parseTransaction({
          data: executeTx.data,
        });
        expect(decodedExecute.name).to.equal('execute');
        expect(decodedExecute.args[1]).to.equal(
          accessManagerInterface.parseTransaction({ data: scheduleTx.data })
            .args[1],
        );
        expect(await readChain3DestinationGas()).to.not.equal('904');
      });
    });

    // Deploys a chain3 warp route owned by the ICA of a chain2 AccessManager and
    // writes an ICA -> AccessManager -> jsonRpc strategy for it.
    async function deployAccessManagerOwnedIcaWarpRoute(
      executionDelay: number,
    ): Promise<{
      accessManager: IAccessManager;
      warpDeployConfig: WarpRouteDeployConfig;
    }> {
      const accessManager = await deployTestAccessManager(
        chain2Signer,
        initialOwnerAddress,
      );
      await grantAccess({
        accessManager,
        target: chain2Addresses.interchainAccountRouter,
        selector: callRemoteWithOverridesSelector,
        account: initialOwnerAddress,
        executionDelay,
      });
      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[CHAIN_3].owner = await deriveChain3Ica(
        accessManager.address,
      );
      await deployAndExportWarpRoute();
      writeAccessManagerStrategy({
        type: TxSubmitterType.INTERCHAIN_ACCOUNT,
        chain: CHAIN_2,
        destinationChain: CHAIN_3,
        owner: accessManager.address,
        refundAddress: initialOwnerAddress,
        internalSubmitter: {
          type: TxSubmitterType.ACCESS_MANAGER,
          chain: CHAIN_2,
          accessManagerAddress: accessManager.address,
          caller: initialOwnerAddress,
          proposerSubmitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN_2,
          },
        },
      });
      return { accessManager, warpDeployConfig };
    }

    it('should schedule and later execute the callRemote of an AccessManager owned interchain account', async () => {
      const { accessManager, warpDeployConfig } =
        await deployAccessManagerOwnedIcaWarpRoute(EXECUTION_DELAY);
      const expectedGas = '47000';
      stageDestinationGasUpdate(warpDeployConfig, expectedGas);

      const res = await applyWithAccessManagerStrategy();

      expect(res.exitCode).to.equal(0);
      expect(await readChain3DestinationGas()).to.not.equal(expectedGas);
      const executeTxs = readDeferredExecuteTxs(
        res.text(),
        TxSubmitterType.INTERCHAIN_ACCOUNT,
      );
      expect(executeTxs).to.have.lengthOf(1);
      const [executeTx] = executeTxs;
      expect(eqAddress(executeTx.to, accessManager.address)).to.be.true;
      expect(executeTx.chainId).to.equal(
        TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.chainId,
      );
      assert(executeTx.value, 'expected the execute tx to carry the IGP value');
      expect(BigNumber.from(executeTx.value).gt(0)).to.be.true;
      const decodedExecute = accessManagerInterface.parseTransaction({
        data: executeTx.data,
      });
      expect(decodedExecute.name).to.equal('execute');
      expect(
        eqAddress(
          decodedExecute.args[0],
          chain2Addresses.interchainAccountRouter,
        ),
      ).to.be.true;

      await increaseEvmTime(
        TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.rpcUrl,
        EXECUTION_DELAY,
      );
      const executeReceipt = await (
        await chain2Signer.sendTransaction(toTxRequest(executeTx))
      ).wait();
      const relayRes = await hyperlaneStatus({
        registry: REGISTRY_PATH,
        origin: CHAIN_2,
        dispatchTx: executeReceipt.transactionHash,
        relay: true,
        key: HYP_KEY_BY_PROTOCOL.ethereum,
      });
      expect(relayRes.exitCode).to.equal(0);

      expect(await readChain3DestinationGas()).to.equal(expectedGas);
    });

    it('should relay the callRemote executed immediately by an AccessManager owned interchain account', async () => {
      const { warpDeployConfig } =
        await deployAccessManagerOwnedIcaWarpRoute(0);
      const expectedGas = '47500';
      stageDestinationGasUpdate(warpDeployConfig, expectedGas);

      const res = await applyWithAccessManagerStrategy(true);

      expect(res.exitCode).to.equal(0);
      expect(
        readDeferredExecuteTxs(res.text(), TxSubmitterType.INTERCHAIN_ACCOUNT),
      ).to.have.lengthOf(0);
      expect(await readChain3DestinationGas()).to.equal(expectedGas);
    });

    it('should relay the ownership transfer callRemote executed immediately by an AccessManager owned interchain account', async () => {
      const { warpDeployConfig } =
        await deployAccessManagerOwnedIcaWarpRoute(0);
      const icaAddress = warpDeployConfig[CHAIN_3].owner;
      const newOwner = Wallet.createRandom().address;
      warpDeployConfig[CHAIN_3].owner = newOwner;
      // Keep the ProxyAdmin owner so the token transfer is the only ownership tx
      warpDeployConfig[CHAIN_3].proxyAdmin = { owner: icaAddress };
      const expectedGas = '47600';
      stageDestinationGasUpdate(warpDeployConfig, expectedGas);

      const res = await applyWithAccessManagerStrategy(true);

      expect(res.exitCode).to.equal(0);
      expect(
        readDeferredExecuteTxs(res.text(), TxSubmitterType.INTERCHAIN_ACCOUNT),
      ).to.have.lengthOf(0);
      const config = await evmWarpCommands.readConfig(
        CHAIN_3,
        WARP_CORE_CONFIG_PATH,
      );
      expect(config[CHAIN_3].destinationGas?.[chain2DomainId]).to.equal(
        expectedGas,
      );
      expect(eqAddress(config[CHAIN_3].owner, newOwner)).to.be.true;
    });

    it('should schedule through an interchain account proposer and execute through it after the delay', async () => {
      const { accessManager, warpDeployConfig } =
        await deployAccessManagerOwnedWarpRoute();
      await grantAccess({
        accessManager,
        target: getChain3WarpTokenAddress(),
        selector: setDestinationGasSelector,
        account: chain3IcaAddress,
        executionDelay: EXECUTION_DELAY,
      });
      writeAccessManagerStrategy({
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_3,
        accessManagerAddress: accessManager.address,
        caller: chain3IcaAddress,
        proposerSubmitter: {
          type: TxSubmitterType.INTERCHAIN_ACCOUNT,
          chain: CHAIN_2,
          destinationChain: CHAIN_3,
          owner: initialOwnerAddress,
          internalSubmitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN_2,
          },
        },
      });
      const expectedGas = '48000';
      stageDestinationGasUpdate(warpDeployConfig, expectedGas);

      const res = await applyWithAccessManagerStrategy(true);

      expect(res.exitCode).to.equal(0);
      const executeTxs = readDeferredExecuteTxs(
        res.text(),
        TxSubmitterType.ACCESS_MANAGER,
      );
      expect(executeTxs).to.have.lengthOf(1);
      const [executeTx] = executeTxs;
      const [target, targetData] = accessManagerInterface.parseTransaction({
        data: executeTx.data,
      }).args;
      const operationId = await accessManager.hashOperation(
        chain3IcaAddress,
        target,
        targetData,
      );
      // The relayed ICA message must have scheduled the operation for the ICA
      expect(await accessManager.getSchedule(operationId)).to.be.greaterThan(0);
      expect(await readChain3DestinationGas()).to.not.equal(expectedGas);

      await increaseEvmTime(
        TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_3.rpcUrl,
        EXECUTION_DELAY,
      );
      writeYamlOrJson(ACCESS_MANAGER_EXECUTE_TXS_PATH, executeTxs);
      rmSync(ACCESS_MANAGER_SUBMIT_RECEIPTS_DIR, {
        recursive: true,
        force: true,
      });
      const submitRes = await hyperlaneSubmit({
        transactionsPath: ACCESS_MANAGER_EXECUTE_TXS_PATH,
        registry: REGISTRY_PATH,
        strategyPath: JSON_RPC_ICA_STRATEGY_CONFIG_PATH,
        receiptsPath: ACCESS_MANAGER_SUBMIT_RECEIPTS_DIR,
      });
      expect(submitRes.exitCode).to.equal(0);

      const receiptFiles = readdirSync(ACCESS_MANAGER_SUBMIT_RECEIPTS_DIR);
      expect(receiptFiles).to.have.lengthOf(1);
      const [callRemoteReceipt]: Array<{ transactionHash: string }> =
        readYamlOrJson(
          `${ACCESS_MANAGER_SUBMIT_RECEIPTS_DIR}/${receiptFiles[0]}`,
        );
      const relayRes = await hyperlaneStatus({
        registry: REGISTRY_PATH,
        origin: CHAIN_2,
        dispatchTx: callRemoteReceipt.transactionHash,
        relay: true,
        key: HYP_KEY_BY_PROTOCOL.ethereum,
      });
      expect(relayRes.exitCode).to.equal(0);

      expect(await readChain3DestinationGas()).to.equal(expectedGas);
    });
  });

  describe('fee transaction bucketing', () => {
    // setFeeContract(uint32,address) — the fee-contract-owner op produced when a
    // RoutingFee sub-fee contract is (re)deployed during apply.
    const SET_FEE_CONTRACT_SELECTOR = '0x16068373';

    function buildIcaFileSubmitter(
      filepath: string,
    ): ExtendedSubmissionStrategy['submitter'] {
      return {
        type: TxSubmitterType.INTERCHAIN_ACCOUNT,
        chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        destinationChain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        internalSubmitter: {
          type: CustomTxSubmitterType.FILE,
          chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          filepath,
        },
      };
    }

    // Deploys a chain3 synthetic warp token (owned by `owner`, the chain3 ICA by
    // default) carrying a
    // RoutingFee whose CHAIN_NAME_2 sub-fee is a LinearFee, then stages a change
    // that produces BOTH a router-owner tx (setDestinationGas, targets the warp
    // token) and a fee-contract-owner tx (setFeeContract, targets the routing
    // fee contract — the LinearFee sub-fee is immutable so a bps change forces a
    // redeploy + setFeeContract). Returns the chain3 warp token address.
    async function deployFeeRouteAndStageChange(
      owner: Address = chain3IcaAddress,
    ): Promise<Address> {
      const warpDeployConfig = fixture.getDeployConfig();
      const chain3Config =
        warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3];
      chain3Config.owner = owner;
      chain3Config.tokenFee = {
        type: TokenFeeType.RoutingFee,
        owner,
        feeContracts: {
          [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
            type: TokenFeeType.LinearFee,
            bps: 50,
          },
        },
      };
      await deployAndExportWarpRoute();

      chain3Config.destinationGas = { [chain2DomainId]: '46000' };
      chain3Config.tokenFee = {
        type: TokenFeeType.RoutingFee,
        owner,
        feeContracts: {
          [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
            type: TokenFeeType.LinearFee,
            bps: 25,
          },
        },
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      return getChain3WarpTokenAddress();
    }

    // Reads an ICA file-submitter output file, asserts it holds exactly one
    // callRemote to the origin-chain ICA router, and returns its decoded inner
    // calls (each `{ to: bytes32, data }`).
    function readSingleCallRemoteInnerCalls(
      outputPath: string,
    ): Array<{ to: string; data: string }> {
      const callRemoteTxs: Array<CallData & { from: string }> =
        readYamlOrJson(outputPath);
      expect(callRemoteTxs).to.be.an('array').with.lengthOf(1);
      const [callRemoteTx] = callRemoteTxs;
      expect(
        eqAddress(callRemoteTx.to, chain2Addresses.interchainAccountRouter),
      ).to.be.true;
      const decoded =
        InterchainAccountRouter__factory.createInterface().parseTransaction({
          data: callRemoteTx.data,
        });
      expect(decoded.name).to.equal('callRemoteWithOverrides');
      return decoded.args[3];
    }

    function isFeeContractOp(call: { data: string }): boolean {
      return call.data.toLowerCase().startsWith(SET_FEE_CONTRACT_SELECTOR);
    }

    it('merges fee txs into the single ICA callRemote when no feeSubmitter is configured', async () => {
      const chain3WarpToken = await deployFeeRouteAndStageChange();

      const icaFileStrategy: ExtendedChainSubmissionStrategy = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          submitter: buildIcaFileSubmitter(FEE_BUCKET_MERGED_OUTPUT_PATH),
        },
      };
      writeYamlOrJson(FEE_BUCKET_MERGED_STRATEGY_PATH, icaFileStrategy);

      const res = await evmWarpCommands.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        strategyUrl: FEE_BUCKET_MERGED_STRATEGY_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      expect(res.text()).not.to.include(
        'Error in submitWarpApplyTransactions Error:',
      );

      // Without a feeSubmitter the router-owner tx and the fee-contract-owner tx
      // collapse into a SINGLE callRemote (one file, multiple inner calls).
      const innerCalls = readSingleCallRemoteInnerCalls(
        FEE_BUCKET_MERGED_OUTPUT_PATH,
      );
      expect(innerCalls.length).to.be.greaterThan(1);

      // The merged callRemote carries both the fee-contract op and the router op.
      expect(
        innerCalls.some(isFeeContractOp),
        'expected a setFeeContract fee tx in the merged callRemote',
      ).to.be.true;
      expect(
        innerCalls.some((call) =>
          eqAddress(bytes32ToAddress(call.to), chain3WarpToken),
        ),
        'expected a router op targeting the warp token in the merged callRemote',
      ).to.be.true;
    });

    it('relays the separate fee callRemote of a live-broadcast ICA strategy', async () => {
      await deployFeeRouteAndStageChange();

      const res = await evmWarpCommands.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        strategyUrl: JSON_RPC_ICA_STRATEGY_CONFIG_PATH,
        relay: true,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      expect(res.exitCode).to.equal(0);
      const { tokenFee } = (
        await evmWarpCommands.readConfig(
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
          WARP_CORE_CONFIG_PATH,
        )
      )[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3];
      assert(
        tokenFee?.type === TokenFeeType.RoutingFee,
        'expected a RoutingFee token fee',
      );
      const subFee =
        tokenFee.feeContracts?.[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
        ];
      assert(
        subFee?.type === TokenFeeType.LinearFee,
        'expected a LinearFee sub-fee',
      );
      expect(subFee.bps).to.equal(25);
    });

    it(`merges fee txs into the main ${TxSubmitterType.ACCESS_MANAGER} submission when no feeSubmitter is configured`, async () => {
      const accessManager = await deployTestAccessManager(
        chain3Signer,
        initialOwnerAddress,
      );
      const chain3WarpToken = await deployFeeRouteAndStageChange(
        accessManager.address,
      );

      const accessManagerFileStrategy: ExtendedChainSubmissionStrategy = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          submitter: {
            type: TxSubmitterType.ACCESS_MANAGER,
            chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
            accessManagerAddress: accessManager.address,
            proposerSubmitter: {
              type: CustomTxSubmitterType.FILE,
              chain: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3,
              filepath: FEE_BUCKET_MERGED_OUTPUT_PATH,
            },
          },
        },
      };
      writeYamlOrJson(
        FEE_BUCKET_MERGED_STRATEGY_PATH,
        accessManagerFileStrategy,
      );

      const res = await evmWarpCommands.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        strategyUrl: FEE_BUCKET_MERGED_STRATEGY_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      expect(res.exitCode).to.equal(0);
      // A separate fee submission would write its own fee receipts file
      expect(res.text()).not.to.include('Fee transaction receipts');

      const scheduledCalls = readYamlOrJson<CallData[]>(
        FEE_BUCKET_MERGED_OUTPUT_PATH,
      ).map(({ to, data }) => {
        expect(eqAddress(to, accessManager.address)).to.be.true;
        const { name, args } = accessManagerInterface.parseTransaction({
          data,
        });
        expect(name).to.equal('schedule');
        return { to: args[0], data: args[1] };
      });
      expect(scheduledCalls.some(isFeeContractOp)).to.be.true;
      expect(scheduledCalls.some((call) => eqAddress(call.to, chain3WarpToken)))
        .to.be.true;

      const executedCalls = readDeferredExecuteTxs(
        res.text(),
        TxSubmitterType.ACCESS_MANAGER,
      ).map(({ data }) => {
        const { args } = accessManagerInterface.parseTransaction({ data });
        return { to: args[0], data: args[1] };
      });
      expect(executedCalls).to.deep.equal(scheduledCalls);
    });

    it('splits fee txs into a dedicated file when a feeSubmitter is configured', async () => {
      const chain3WarpToken = await deployFeeRouteAndStageChange();

      const splitStrategy: ExtendedChainSubmissionStrategy = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_3]: {
          submitter: buildIcaFileSubmitter(FEE_BUCKET_SPLIT_MAIN_OUTPUT_PATH),
          feeSubmitter: buildIcaFileSubmitter(FEE_BUCKET_SPLIT_FEE_OUTPUT_PATH),
        },
      };
      writeYamlOrJson(FEE_BUCKET_SPLIT_STRATEGY_PATH, splitStrategy);

      const res = await evmWarpCommands.applyRaw({
        warpRouteId: WARP_ROUTE_ID,
        strategyUrl: FEE_BUCKET_SPLIT_STRATEGY_PATH,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      expect(res.text()).not.to.include(
        'Error in submitWarpApplyTransactions Error:',
      );

      // The dedicated feeSubmitter writes the fee-contract op to its own file.
      const feeInnerCalls = readSingleCallRemoteInnerCalls(
        FEE_BUCKET_SPLIT_FEE_OUTPUT_PATH,
      );
      expect(feeInnerCalls.some(isFeeContractOp)).to.be.true;
      expect(feeInnerCalls.every(isFeeContractOp)).to.be.true;

      // The main submitter writes the router op only — no fee-contract op leaks.
      const mainInnerCalls = readSingleCallRemoteInnerCalls(
        FEE_BUCKET_SPLIT_MAIN_OUTPUT_PATH,
      );
      expect(
        mainInnerCalls.some((call) =>
          eqAddress(bytes32ToAddress(call.to), chain3WarpToken),
        ),
      ).to.be.true;
      expect(mainInnerCalls.some(isFeeContractOp)).to.be.false;
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
