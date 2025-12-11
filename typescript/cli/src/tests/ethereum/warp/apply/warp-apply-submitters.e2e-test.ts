import { expect } from 'chai';
import { Signer, Wallet, ethers } from 'ethers';

import {
  InterchainAccountRouter__factory,
  MockSafe__factory,
  TimelockController,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  CallData,
  ChainSubmissionStrategy,
  ChainSubmissionStrategySchema,
  DerivedCoreConfig,
  SubmissionStrategy,
  TokenType,
  TxSubmitterType,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address, Domain, ProtocolType, assert } from '@hyperlane-xyz/utils';

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
      DEFAULT_EVM_WARP_DEPLOY_PATH,
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );

    return warpDeployConfig;
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

      // Extract the transaction file from the logs
      const output = result.text();
      const filePathMatch = output.match(
        /Transaction receipts.*successfully written to (.*-gnosisSafeTxBuilder-.*\.json)/,
      );
      assert(
        filePathMatch,
        'Expected transaction receipts file path in output',
      );
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
