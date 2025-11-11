import { expect } from 'chai';
import { Signer, Wallet, ethers } from 'ethers';

import {
  InterchainAccountRouter__factory,
  TimelockController,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import {
  ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  CallData,
  ChainMetadata,
  ChainSubmissionStrategySchema,
  DerivedCoreConfig,
  SubmissionStrategy,
  TokenType,
  TxSubmitterType,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { Address, Domain, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import {
  deployOrUseExistingCore,
  hyperlaneCoreApply,
  readCoreConfig,
} from '../commands/core.js';
import {
  hyperlaneWarpApplyRaw,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_2,
  CORE_READ_CONFIG_PATH_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  JSON_RPC_ICA_STRATEGY_CONFIG_PATH,
  JSON_RPC_TIMELOCK_STRATEGY_CONFIG_PATH,
  TEMP_PATH,
  WARP_CONFIG_PATH_2,
  WARP_CONFIG_PATH_EXAMPLE,
  getCombinedWarpRoutePath,
} from '../consts.js';

describe('hyperlane warp apply with submitters', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Signer: Signer;
  let chain3Signer: Signer;
  let ownerAddress: Address;
  let chain3Addresses: ChainAddresses = {};
  let chain2Addresses: ChainAddresses = {};
  let initialOwnerAddress: Address;
  let chain2DomainId: Domain;
  let chain3DomainId: Domain;
  let warpDeployConfig: WarpRouteDeployConfig;
  let timelockInstance: TimelockController;
  let chain3IcaAddress: Address;
  let WARP_DEPLOY_CONFIG_PATH: string;
  let WARP_CORE_CONFIG_PATH: string;
  let WARP_ROUTE_ID: string;
  const FORMATTED_TIMELOCK_SUBMITTER_STRATEGY_PATH = `${TEMP_PATH}/timelock-simple-strategy.yaml`;

  before(async function () {
    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);

    const chain2Provider = new ethers.providers.JsonRpcProvider(
      chain2Metadata.rpcUrls[0].http,
    );
    const chain3Provider = new ethers.providers.JsonRpcProvider(
      chain3Metadata.rpcUrls[0].http,
    );
    chain2DomainId = chain2Metadata.domainId;
    chain3DomainId = chain3Metadata.domainId;
    const wallet = new Wallet(ANVIL_KEY);
    chain2Signer = wallet.connect(chain2Provider);

    chain3Signer = wallet.connect(chain3Provider);
    initialOwnerAddress = await chain2Signer.getAddress();

    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    // Create a new warp config using the example
    const warpConfig: WarpRouteDeployConfig = readYamlOrJson(
      WARP_CONFIG_PATH_EXAMPLE,
    );

    const anvil2Config = { anvil2: { ...warpConfig.anvil1 } };
    writeYamlOrJson(WARP_CONFIG_PATH_2, anvil2Config);

    WARP_ROUTE_ID = createWarpRouteConfigId('ETH', CHAIN_NAME_3);
    WARP_CORE_CONFIG_PATH = getCombinedWarpRoutePath('ETH', [CHAIN_NAME_3]);
    WARP_DEPLOY_CONFIG_PATH = WARP_CORE_CONFIG_PATH.replace(
      '-config.yaml',
      '-deploy.yaml',
    );

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

    // Configure ICA connections by enrolling the ICAs with each other
    const [coreConfigChain2, coreConfigChain3]: DerivedCoreConfig[] =
      await Promise.all([
        readCoreConfig(CHAIN_NAME_2, CORE_READ_CONFIG_PATH_2),
        readCoreConfig(CHAIN_NAME_3, CORE_READ_CONFIG_PATH_3),
      ]);

    const coreConfigChain2IcaConfig = coreConfigChain2.interchainAccountRouter!;
    const coreConfigChain3IcaConfig = coreConfigChain3.interchainAccountRouter!;
    coreConfigChain2IcaConfig.remoteRouters = {
      [chain3DomainId]: {
        address: coreConfigChain3IcaConfig.address,
      },
    };

    writeYamlOrJson(CORE_READ_CONFIG_PATH_2, coreConfigChain2);
    await hyperlaneCoreApply(CHAIN_NAME_2, CORE_READ_CONFIG_PATH_2);
  });

  beforeEach(async function () {
    ownerAddress = new Wallet(ANVIL_KEY).address;
    warpDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    formatTimelockStrategyFile();
  });

  function formatTimelockStrategyFile(
    proposerSubmitter?: SubmissionStrategy['submitter'],
  ) {
    // Update the submitter config to use the deployed timelock address
    const timelockSubmitterConfig = ChainSubmissionStrategySchema.parse(
      readYamlOrJson(JSON_RPC_TIMELOCK_STRATEGY_CONFIG_PATH),
    );

    const chain3SubmissionStrategy = timelockSubmitterConfig[CHAIN_NAME_3];
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

    timelockSubmitterConfig[CHAIN_NAME_3] = chain3SubmissionStrategy;

    writeYamlOrJson(
      FORMATTED_TIMELOCK_SUBMITTER_STRATEGY_PATH,
      timelockSubmitterConfig,
    );
  }

  async function deployAndExportWarpRoute(): Promise<WarpRouteDeployConfig> {
    // currently warp deploy is not writing the deploy config to the registry
    // should remove this once the deploy config is written to the registry
    writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_CONFIG_PATH, WARP_ROUTE_ID);

    return warpDeployConfig;
  }

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
      warpDeployConfig[CHAIN_NAME_3].owner = timelockInstance.address;
      await deployAndExportWarpRoute();

      const expectedUpdatedGasValue = '900';
      warpDeployConfig[CHAIN_NAME_3].destinationGas = {
        [chain2DomainId]: expectedUpdatedGasValue,
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      const res = await hyperlaneWarpApplyRaw({
        strategyUrl: FORMATTED_TIMELOCK_SUBMITTER_STRATEGY_PATH,
        warpRouteId: WARP_ROUTE_ID,
      });

      // get the timelock output file from the logs
      const executeTransaction = getTimelockExecuteTxFile(res.text());

      const tx = await chain3Signer.sendTransaction(executeTransaction);
      await tx.wait();

      const updatedWarpDeployConfig_3_2 = await readWarpConfig(
        CHAIN_NAME_3,
        WARP_CORE_CONFIG_PATH,
        WARP_DEPLOY_CONFIG_PATH,
      );

      expect(
        updatedWarpDeployConfig_3_2[CHAIN_NAME_3].destinationGas![
          chain2DomainId
        ],
      ).to.equal(expectedUpdatedGasValue);
    });

    it('should be able to propose transactions to a timelock contract using an ICA', async () => {
      warpDeployConfig[CHAIN_NAME_3].owner = timelockInstance.address;
      await deployAndExportWarpRoute();

      // Set the timelock to use the ICA to propose txs
      formatTimelockStrategyFile({
        type: TxSubmitterType.INTERCHAIN_ACCOUNT,
        chain: CHAIN_NAME_2,
        destinationChain: CHAIN_NAME_3,
        owner: ownerAddress,
        internalSubmitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN_NAME_2,
        },
      });

      const expectedUpdatedGasValue = '900';
      warpDeployConfig[CHAIN_NAME_3].destinationGas = {
        [chain2DomainId]: expectedUpdatedGasValue,
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      const res = await hyperlaneWarpApplyRaw({
        strategyUrl: FORMATTED_TIMELOCK_SUBMITTER_STRATEGY_PATH,
        warpRouteId: WARP_ROUTE_ID,
        relay: true,
      });

      // get the timelock output file from the logs
      const executeTransaction = getTimelockExecuteTxFile(res.text());

      const tx = await chain3Signer.sendTransaction(executeTransaction);
      await tx.wait();

      const updatedWarpDeployConfig_3_2 = await readWarpConfig(
        CHAIN_NAME_3,
        WARP_CORE_CONFIG_PATH,
        WARP_DEPLOY_CONFIG_PATH,
      );

      expect(
        updatedWarpDeployConfig_3_2[CHAIN_NAME_3].destinationGas![
          chain2DomainId
        ],
      ).to.equal(expectedUpdatedGasValue);
    });
  });

  describe(TxSubmitterType.INTERCHAIN_ACCOUNT, () => {
    it('should relay the ICA transaction to update the warp on the destination chain', async () => {
      // Transfer ownership of the warp token on chain3 to the ICA account
      warpDeployConfig[CHAIN_NAME_3].owner = chain3IcaAddress;
      await deployAndExportWarpRoute();

      // Update the remote gas for chain2 on chain3 and run warp apply with an ICA strategy
      const expectedChain2Gas = '46000';
      warpDeployConfig[CHAIN_NAME_3].destinationGas = {
        [chain2DomainId]: expectedChain2Gas,
      };
      writeYamlOrJson(WARP_DEPLOY_CONFIG_PATH, warpDeployConfig);

      await hyperlaneWarpApplyRaw({
        strategyUrl: JSON_RPC_ICA_STRATEGY_CONFIG_PATH,
        warpRouteId: WARP_ROUTE_ID,
        relay: true,
      });

      const updatedWarpDeployConfig_3_2 = await readWarpConfig(
        CHAIN_NAME_3,
        WARP_CORE_CONFIG_PATH,
        WARP_DEPLOY_CONFIG_PATH,
      );

      expect(
        updatedWarpDeployConfig_3_2[CHAIN_NAME_3].destinationGas![
          chain2DomainId
        ],
      ).to.equal(expectedChain2Gas);
    });
  });
});
