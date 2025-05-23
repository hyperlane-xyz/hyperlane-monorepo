import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet, ethers } from 'ethers';
import { rmSync } from 'fs';
import { $ } from 'zx';

import {
  ERC20,
  ERC20__factory,
  HypERC20Collateral__factory,
  MockValueTransferBridge__factory,
} from '@hyperlane-xyz/core';
import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  Domain,
  addressToBytes32,
  bytes32ToAddress,
  sleep,
  toWei,
} from '@hyperlane-xyz/utils';

import { StrategyOptions } from '../../rebalancer/index.js';
import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_4_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REBALANCER_CONFIG_PATH,
  createSnapshot,
  deployOrUseExistingCore,
  deployToken,
  getCombinedWarpRoutePath,
  hyperlaneRelayer,
  restoreSnapshot,
} from '../commands/helpers.js';
import {
  hyperlaneWarpDeploy,
  hyperlaneWarpRebalancer,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';

chai.use(chaiAsPromised);
chai.should();

describe('hyperlane warp rebalancer e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  // How often the rebalancer will check for a rebalance to be triggered
  // The first run is always done on start
  // The rest are done every CHECK_FREQUENCY ms
  // For these tests we mostly care about the first run
  const CHECK_FREQUENCY = 60000;

  const DEFAULT_METRICS_SERVER = 'http://localhost:9090/metrics';

  let tokenSymbol: string;
  let warpRouteId: string;
  let snapshots: { rpcUrl: string; snapshotId: string }[] = [];
  let ogVerbose: boolean;

  let warpDeploymentPath: string;

  let warpCoreConfig: WarpCoreConfig;
  let chain2Metadata: ChainMetadata;
  let chain3Metadata: ChainMetadata;
  let chain4Metadata: ChainMetadata;

  let chain2Addresses: Record<string, string>;
  let chain3Addresses: Record<string, string>;
  let chain4Addresses: Record<string, string>;

  let tokenChain2: ERC20;
  let tokenChain3: ERC20;

  before(async () => {
    ogVerbose = $.verbose;
    $.verbose = false;

    console.log('Deploying core contracts on all chains...');

    [chain2Addresses, chain3Addresses, chain4Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_4, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    console.log('Deploying ERC20s...');

    [tokenChain2, tokenChain3] = await Promise.all([
      deployToken(ANVIL_KEY, CHAIN_NAME_2),
      deployToken(ANVIL_KEY, CHAIN_NAME_3),
    ]);
    tokenSymbol = await tokenChain2.symbol();

    console.log('Deploying Warp Route...');

    warpDeploymentPath = getCombinedWarpRoutePath(tokenSymbol, [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      CHAIN_NAME_4,
    ]);
    const warpRouteDeployConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: tokenChain2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ANVIL_DEPLOYER_ADDRESS,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.collateral,
        token: tokenChain3.address,
        mailbox: chain3Addresses.mailbox,
        owner: ANVIL_DEPLOYER_ADDRESS,
      },
      [CHAIN_NAME_4]: {
        type: TokenType.synthetic,
        mailbox: chain4Addresses.mailbox,
        owner: ANVIL_DEPLOYER_ADDRESS,
      },
    };
    writeYamlOrJson(warpDeploymentPath, warpRouteDeployConfig);
    await hyperlaneWarpDeploy(warpDeploymentPath);

    warpCoreConfig = readYamlOrJson(warpDeploymentPath);
    chain2Metadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    chain3Metadata = readYamlOrJson(CHAIN_3_METADATA_PATH);
    chain4Metadata = readYamlOrJson(CHAIN_4_METADATA_PATH);

    console.log('Bridging tokens...');

    await Promise.all([
      hyperlaneWarpSendRelay(
        CHAIN_NAME_2,
        CHAIN_NAME_4,
        warpDeploymentPath,
        true,
        toWei(10),
      ),
      sleep(2000).then(() =>
        hyperlaneWarpSendRelay(
          CHAIN_NAME_3,
          CHAIN_NAME_4,
          warpDeploymentPath,
          true,
          toWei(10),
        ),
      ),
    ]);

    warpRouteId = createWarpRouteConfigId(tokenSymbol.toUpperCase(), [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      CHAIN_NAME_4,
    ]);
  });

  after(() => {
    $.verbose = ogVerbose;
  });

  beforeEach(async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: '100',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: '100',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
    });

    const chain2RpcUrl = chain2Metadata.rpcUrls[0].http;
    const chain3RpcUrl = chain3Metadata.rpcUrls[0].http;
    const chain4RpcUrl = chain4Metadata.rpcUrls[0].http;

    snapshots = [
      {
        rpcUrl: chain2RpcUrl,
        snapshotId: await createSnapshot(chain2RpcUrl),
      },
      {
        rpcUrl: chain3RpcUrl,
        snapshotId: await createSnapshot(chain3RpcUrl),
      },
      {
        rpcUrl: chain4RpcUrl,
        snapshotId: await createSnapshot(chain4RpcUrl),
      },
    ];
  });

  afterEach(async () => {
    rmSync(REBALANCER_CONFIG_PATH, { force: true });

    await Promise.all(
      snapshots.map(({ rpcUrl, snapshotId }) =>
        restoreSnapshot(rpcUrl, snapshotId),
      ),
    );
  });

  function startRebalancer(
    options: {
      checkFrequency?: number;
      withMetrics?: boolean;
      rebalanceStrategy?: string;
      monitorOnly?: boolean;
      origin?: string;
      destination?: string;
      amount?: string;
    } = {},
  ) {
    const {
      checkFrequency = CHECK_FREQUENCY,
      withMetrics = false,
      rebalanceStrategy,
      monitorOnly = false,
      origin,
      destination,
      amount,
    } = options;

    return hyperlaneWarpRebalancer(
      warpRouteId,
      checkFrequency,
      REBALANCER_CONFIG_PATH,
      withMetrics,
      rebalanceStrategy,
      monitorOnly,
      origin,
      destination,
      amount,
    );
  }

  async function startRebalancerAndExpectLog(
    log: string | string[],
    options: {
      timeout?: number;
      checkFrequency?: number;
      withMetrics?: boolean;
      rebalanceStrategy?: string;
      monitorOnly?: boolean;
      origin?: string;
      destination?: string;
      amount?: string;
    } = {},
  ) {
    const {
      timeout = 10_000,
      checkFrequency,
      withMetrics,
      rebalanceStrategy,
      monitorOnly,
      origin,
      destination,
      amount,
    } = options;

    const process = startRebalancer({
      checkFrequency,
      withMetrics,
      rebalanceStrategy,
      monitorOnly,
      origin,
      destination,
      amount,
    });

    let timeoutId: NodeJS.Timeout;

    const expectedLogs = (() => {
      if (Array.isArray(log)) {
        if (log.length === 0) {
          throw new Error('Expected at least one log');
        }

        return log;
      }

      return [log];
    })();

    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      // Use a timeout to prevent waiting for a log that might never happen and fail faster
      timeoutId = setTimeout(async () => {
        reject(new Error(`Timeout waiting for log: "${expectedLogs[0]}"`));
      }, timeout);

      // Handle when the process exits due to an error that is not the expected log
      process.catch((e) => {
        const lines = e.lines();
        const error = lines[lines.length - 1];

        reject(
          new Error(
            `Process failed before logging: "${expectedLogs[0]}" with error: ${error}`,
          ),
        );
      });

      // Wait for the process to output the expected log.
      for await (let chunk of process.stdout) {
        chunk = typeof chunk === 'string' ? chunk : chunk.toString();

        if (chunk.includes(expectedLogs[0])) {
          expectedLogs.shift();

          if (!expectedLogs.length) {
            resolve(void 0);
            break;
          }
        }
      }
    }).finally(() => {
      // Perform a cleanup at the end
      clearTimeout(timeoutId);
      void process.kill();
    });
  }

  it('should successfully start the rebalancer', async () => {
    await startRebalancerAndExpectLog('Rebalancer started successfully 🚀');
  });

  it('should throw when strategy config file does not exist', async () => {
    rmSync(REBALANCER_CONFIG_PATH);

    await startRebalancerAndExpectLog(
      `File doesn't exist at ${REBALANCER_CONFIG_PATH}`,
    );
  });

  it('should throw if a weight value cannot be parsed as bigint', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: 'weight',
        tolerance: 0,
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: 100,
        tolerance: 0,
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
    });

    await startRebalancerAndExpectLog(`Cannot convert weight to a BigInt`);
  });

  it('should throw if a tolerance value cannot be parsed as bigint', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: 100,
        tolerance: 0,
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: 100,
        tolerance: 'tolerance',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
    });

    await startRebalancerAndExpectLog(`Cannot convert tolerance to a BigInt`);
  });

  it('should throw if a bridge value is not a valid address', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: 100,
        tolerance: 0,
        bridge: 'bridge',
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: 100,
        tolerance: 0,
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
    });

    await startRebalancerAndExpectLog(
      `Validation error: Invalid at "anvil2.bridge"`,
    );
  });

  it('should log that no routes are to be executed', async () => {
    await startRebalancerAndExpectLog(
      `No routes to execute. Assuming rebalance is complete. Resetting semaphore timer.`,
    );
  });

  it('should not rebalance if mode is monitorOnly', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      monitorOnly: true,
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
    });

    await startRebalancerAndExpectLog(
      `Running in monitorOnly mode: no transactions will be executed.`,
    );
  });

  it('should throw if key does not belong to the assigned rebalancer', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
    });

    await startRebalancerAndExpectLog(
      `Signer ${ANVIL_DEPLOYER_ADDRESS} is not a rebalancer`,
    );
  });

  it('should throw if the destination is not allowed', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
    });

    // Assign rebalancer role
    const chain3Provider = new ethers.providers.JsonRpcProvider(
      chain3Metadata.rpcUrls[0].http,
    );
    const chain3Signer = new Wallet(ANVIL_KEY, chain3Provider);
    const chain3CollateralContract = HypERC20Collateral__factory.connect(
      warpCoreConfig.tokens[1].addressOrDenom!,
      chain3Signer,
    );
    const rebalancerRole = await chain3CollateralContract.REBALANCER_ROLE();
    await chain3CollateralContract.grantRole(
      rebalancerRole,
      chain3Signer.address,
    );

    await startRebalancerAndExpectLog(
      `Destination ${warpCoreConfig.tokens[0].addressOrDenom!} for domain ${
        chain2Metadata.domainId
      } (${chain2Metadata.name}) is not allowed. From ${
        warpCoreConfig.tokens[1].addressOrDenom
      } at ${chain3Metadata.name}`,
    );
  });

  it('should throw if the bridge is not allowed', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
    });

    // Assign rebalancer role
    const chain3Provider = new ethers.providers.JsonRpcProvider(
      chain3Metadata.rpcUrls[0].http,
    );
    const chain3Signer = new Wallet(ANVIL_KEY, chain3Provider);
    const chain3CollateralContract = HypERC20Collateral__factory.connect(
      warpCoreConfig.tokens[1].addressOrDenom!,
      chain3Signer,
    );
    const rebalancerRole = await chain3CollateralContract.REBALANCER_ROLE();
    await chain3CollateralContract.grantRole(
      rebalancerRole,
      chain3Signer.address,
    );

    // Allow destination
    await chain3CollateralContract.addRecipient(
      chain2Metadata.domainId,
      addressToBytes32(warpCoreConfig.tokens[0].addressOrDenom!),
    );

    await startRebalancerAndExpectLog(
      `Bridge ${ethers.constants.AddressZero} for domain ${chain2Metadata.domainId} (${
        chain2Metadata.name
      }) is not allowed. From ${warpCoreConfig.tokens[0].addressOrDenom} at ${
        chain3Metadata.name
      }. To ${warpCoreConfig.tokens[1].addressOrDenom} at ${chain2Metadata.name}.`,
    );
  });

  it('should throw if rebalance quotes cannot be obtained', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
    });

    // Assign rebalancer role
    const chain3Provider = new ethers.providers.JsonRpcProvider(
      chain3Metadata.rpcUrls[0].http,
    );
    const chain3Signer = new Wallet(ANVIL_KEY, chain3Provider);
    const chain3CollateralContract = HypERC20Collateral__factory.connect(
      warpCoreConfig.tokens[1].addressOrDenom!,
      chain3Signer,
    );
    const rebalancerRole = await chain3CollateralContract.REBALANCER_ROLE();
    await chain3CollateralContract.grantRole(
      rebalancerRole,
      chain3Signer.address,
    );

    // Allow destination
    await chain3CollateralContract.addRecipient(
      chain2Metadata.domainId,
      addressToBytes32(warpCoreConfig.tokens[0].addressOrDenom!),
    );

    // Allow bridge
    await chain3CollateralContract.addBridge(
      ethers.constants.AddressZero,
      chain2Metadata.domainId,
    );

    await startRebalancerAndExpectLog(
      `Could not get rebalance quotes from ${chain3Metadata.name} to ${
        chain2Metadata.name
      }: All providers failed on chain unknown for method call and params`,
    );
  });

  it('should successfully send rebalance transaction', async () => {
    // Assign rebalancer role
    const chain3Provider = new ethers.providers.JsonRpcProvider(
      chain3Metadata.rpcUrls[0].http,
    );
    const chain3Signer = new Wallet(ANVIL_KEY, chain3Provider);
    const chain3CollateralContract = HypERC20Collateral__factory.connect(
      warpCoreConfig.tokens[1].addressOrDenom!,
      chain3Signer,
    );
    const rebalancerRole = await chain3CollateralContract.REBALANCER_ROLE();
    await chain3CollateralContract.grantRole(
      rebalancerRole,
      chain3Signer.address,
    );

    // Allow destination
    await chain3CollateralContract.addRecipient(
      chain2Metadata.domainId,
      addressToBytes32(warpCoreConfig.tokens[0].addressOrDenom!),
    );

    // Deploy the bridge
    const bridgeContract = await new MockValueTransferBridge__factory(
      chain3Signer,
    ).deploy();

    // Allow bridge
    await chain3CollateralContract.addBridge(
      bridgeContract.address,
      chain2Metadata.domainId,
    );

    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: bridgeContract.address,
        bridgeLockTime: 1,
      },
    });

    await startRebalancerAndExpectLog('✅ Rebalance successful');
  });

  it('should skip rebalance if amount is below minimum threshold', async () => {
    // Assign rebalancer role
    const chain3Provider = new ethers.providers.JsonRpcProvider(
      chain3Metadata.rpcUrls[0].http,
    );
    const chain3Signer = new Wallet(ANVIL_KEY, chain3Provider);
    const chain3CollateralContract = HypERC20Collateral__factory.connect(
      warpCoreConfig.tokens[1].addressOrDenom!,
      chain3Signer,
    );
    const rebalancerRole = await chain3CollateralContract.REBALANCER_ROLE();
    await chain3CollateralContract.grantRole(
      rebalancerRole,
      chain3Signer.address,
    );

    // Allow destination
    await chain3CollateralContract.addRecipient(
      chain2Metadata.domainId,
      addressToBytes32(warpCoreConfig.tokens[0].addressOrDenom!),
    );

    // Deploy the bridge
    const bridgeContract = await new MockValueTransferBridge__factory(
      chain3Signer,
    ).deploy();

    // Allow bridge
    await chain3CollateralContract.addBridge(
      bridgeContract.address,
      chain2Metadata.domainId,
    );

    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: bridgeContract.address,
        bridgeLockTime: 1,
        bridgeMinAcceptedAmount: '5000000000000000001',
      },
    });

    await startRebalancerAndExpectLog(
      'Rebalance skipped: No routes to execute',
    );
  });

  it('should successfully rebalance tokens between chains using a mock bridge', async () => {
    const wccTokens = warpCoreConfig.tokens;

    // Contract addresses
    // For this test, rebalance will consist of sending tokens from chain 3 to chain 2
    const originContractAddress = wccTokens[1].addressOrDenom!;
    const destContractAddress = wccTokens[0].addressOrDenom!;

    // Addresses of the wrapped collateral tokens
    const originTknAddress = wccTokens[1].collateralAddressOrDenom!;
    const destTknAddress = wccTokens[0].collateralAddressOrDenom!;

    // Domain IDs
    const originDomain = chain3Metadata.domainId;
    const destDomain = chain2Metadata.domainId;

    // Chain names
    const originName = CHAIN_NAME_3;
    const destName = CHAIN_NAME_2;

    // RPC URLs
    const originRpc = chain3Metadata.rpcUrls[0].http;
    const destRpc = chain2Metadata.rpcUrls[0].http;

    // Assign rebalancer role
    // We need to assign to the contract who is able to send the rebalance transaction
    const originProvider = new ethers.providers.JsonRpcProvider(originRpc);
    const destProvider = new ethers.providers.JsonRpcProvider(destRpc);
    const originSigner = new Wallet(ANVIL_KEY, originProvider);
    const originContract = HypERC20Collateral__factory.connect(
      originContractAddress,
      originSigner,
    );
    const rebalancerRole = await originContract.REBALANCER_ROLE();
    await originContract.grantRole(rebalancerRole, originSigner.address);

    // Allow destination
    // We have to allow for a particular domain (chain 2) that the destination contract is able to receive the tokens
    await originContract.addRecipient(
      destDomain,
      addressToBytes32(destContractAddress),
    );

    // Deploy the bridge
    // This mock contract will be used to allow the rebalance transaction to be sent
    // It will also allow us to mock some token movement
    const bridgeContract = await new MockValueTransferBridge__factory(
      originSigner,
    ).deploy();

    // Allow bridge
    // This allow the bridge to be used to send the rebalance transaction
    await originContract.addBridge(bridgeContract.address, destDomain);

    // Configure rebalancer
    // Given that the rebalance will be performed by sending tokens from chain 3 to chain 2
    // we need to add the address of the allowed bridge to chain 3
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: bridgeContract.address,
        bridgeLockTime: 1,
      },
    });

    // Promise that will resolve with the event that is emitted by the bridge when the rebalance transaction is sent
    const listenForSentTransferRemote = new Promise<{
      origin: Domain;
      destination: Domain;
      recipient: Address;
      amount: bigint;
    }>((resolve) => {
      bridgeContract.on(
        bridgeContract.filters.SentTransferRemote(),
        (origin, destination, recipient, amount) => {
          resolve({
            origin,
            destination,
            recipient: bytes32ToAddress(recipient),
            amount: amount.toBigInt(),
          });

          bridgeContract.removeAllListeners();
        },
      );
    });

    // Start the rebalancer
    const rebalancer = startRebalancer();

    // Await for the event that is emitted when the rebalance is triggered
    const sentTransferRemote = await listenForSentTransferRemote;

    // Verify the different params of the event to make sure that the transfer of 5TKN is being done from chain 3 to chain 2
    expect(sentTransferRemote.origin).to.equal(originDomain);
    expect(sentTransferRemote.destination).to.equal(destDomain);
    expect(sentTransferRemote.recipient).to.equal(destContractAddress);
    expect(sentTransferRemote.amount).to.equal(BigInt(toWei(5)));

    const originTkn = ERC20__factory.connect(originTknAddress, originProvider);
    const destTkn = ERC20__factory.connect(destTknAddress, destProvider);

    let originBalance = await originTkn.balanceOf(originContractAddress);
    let destBalance = await destTkn.balanceOf(destContractAddress);

    // Verify that the tokens are in the right place before the transfer
    expect(originBalance.toString()).to.equal(toWei(10));
    expect(destBalance.toString()).to.equal(toWei(10));

    // Simulate rebalancing by transferring tokens from destination to origin chain.
    // This process locks tokens on the destination chain and unlocks them on the origin,
    // effectively increasing collateral on the destination while decreasing it on the origin,
    // which achieves the desired rebalancing effect.
    await hyperlaneWarpSendRelay(
      destName,
      originName,
      warpDeploymentPath,
      true,
      sentTransferRemote.amount.toString(),
    );

    originBalance = await originTkn.balanceOf(originContractAddress);
    destBalance = await destTkn.balanceOf(destContractAddress);

    // Verify that the tokens have been rebalanced according their weights defined by the config
    expect(originBalance.toString()).to.equal(toWei(5));
    expect(destBalance.toString()).to.equal(toWei(15));

    // Kill the process to finish the test
    await rebalancer.kill();

    // Running the rebalancer again should not trigger any rebalance given that it is already balanced.
    await startRebalancerAndExpectLog(
      `No routes to execute. Assuming rebalance is complete. Resetting semaphore timer.`,
    );
  });

  it('should throw when the semaphore timer has not expired', async () => {
    const wccTokens = warpCoreConfig.tokens;
    const originContractAddress = wccTokens[1].addressOrDenom!;
    const destContractAddress = wccTokens[0].addressOrDenom!;
    const destDomain = chain2Metadata.domainId;
    const originRpc = chain3Metadata.rpcUrls[0].http;

    // --- Add rebalancer role ---

    const originProvider = new ethers.providers.JsonRpcProvider(originRpc);
    const originSigner = new Wallet(ANVIL_KEY, originProvider);
    const originContract = HypERC20Collateral__factory.connect(
      originContractAddress,
      originSigner,
    );
    const rebalancerRole = await originContract.REBALANCER_ROLE();
    await originContract.grantRole(rebalancerRole, originSigner.address);

    // --- Allow destination ---

    await originContract.addRecipient(
      destDomain,
      addressToBytes32(destContractAddress),
    );

    // --- Deploy the bridge ---

    const bridgeContract = await new MockValueTransferBridge__factory(
      originSigner,
    ).deploy();

    // --- Allow bridge ---

    await originContract.addBridge(bridgeContract.address, destDomain);

    // --- Configure rebalancer ---

    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 10000,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: bridgeContract.address,
        bridgeLockTime: 10000,
      },
    });

    // --- Start rebalancer ---

    await startRebalancerAndExpectLog(
      `Still in waiting period. Skipping rebalance.`,
      {
        checkFrequency: 2000,
      },
    );
  });

  it('should successfully log metrics tracking', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
    });

    await startRebalancerAndExpectLog('Wallet balance updated for token', {
      withMetrics: true,
    });
  });

  it('should start the metrics server and expose prometheus metrics', async () => {
    const process = startRebalancer({ withMetrics: true });

    // Give the server some time to start
    // TODO: find a deterministic approach to this, as it may fail due to resource restrictions
    await sleep(3500);

    // Check if the metrics endpoint is responding
    const response = await fetch(DEFAULT_METRICS_SERVER);
    expect(response.status).to.equal(200);

    // Get the metrics content
    const metricsText = await response.text();
    expect(metricsText).to.not.be.empty;
    expect(metricsText).to.include('# HELP');
    expect(metricsText).to.include('# TYPE');

    // Check for specific Hyperlane metrics
    expect(metricsText).to.include('hyperlane_wallet_balance');

    await process.kill();
  });

  it('should not find any metrics server when metrics are not enabled', async () => {
    const process = startRebalancer({ withMetrics: false });

    // Give the server some time to start
    // TODO: find a deterministic approach to this, as it may fail due to resource restrictions
    await sleep(3500);

    // Check that metrics endpoint is not responding
    await fetch(DEFAULT_METRICS_SERVER).should.be.rejected;

    await process.kill();
  });

  it('should use the rebalanceStrategy flag to override the config file', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      [CHAIN_NAME_2]: {
        minAmount: '-100',
        target: '110',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
      [CHAIN_NAME_3]: {
        minAmount: '100',
        target: '110',
        bridge: ethers.constants.AddressZero,
        bridgeLockTime: 1,
      },
    });

    await startRebalancerAndExpectLog('Minimum amount cannot be negative', {
      timeout: 10000,
      withMetrics: false,
      rebalanceStrategy: StrategyOptions.MinAmount,
    });
  });

  it('should use another warp route as bridge', async () => {
    // --- Deploy the other warp route ---

    const otherWarpDeploymentPath = getCombinedWarpRoutePath(tokenSymbol, [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);
    const otherWarpRouteDeployConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: tokenChain2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ANVIL_DEPLOYER_ADDRESS,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.collateral,
        token: tokenChain3.address,
        mailbox: chain3Addresses.mailbox,
        owner: ANVIL_DEPLOYER_ADDRESS,
      },
    };
    writeYamlOrJson(otherWarpDeploymentPath, otherWarpRouteDeployConfig);
    await hyperlaneWarpDeploy(otherWarpDeploymentPath);

    const otherWarpCoreConfig: WarpCoreConfig = readYamlOrJson(
      otherWarpDeploymentPath,
    );

    const chain2Signer = new Wallet(
      ANVIL_KEY,
      new ethers.providers.JsonRpcProvider(chain2Metadata.rpcUrls[0].http),
    );

    const chain3Signer = new Wallet(
      ANVIL_KEY,
      new ethers.providers.JsonRpcProvider(chain3Metadata.rpcUrls[0].http),
    );

    const chain2Contract = HypERC20Collateral__factory.connect(
      warpCoreConfig.tokens[0].addressOrDenom!,
      chain2Signer,
    );

    // --- Grant rebalancer role ---

    await chain2Contract.grantRole(
      await chain2Contract.REBALANCER_ROLE(),
      chain2Signer.address,
    );

    // --- Allow destination ---

    await chain2Contract.addRecipient(
      chain3Metadata.domainId,
      addressToBytes32(warpCoreConfig.tokens[1].addressOrDenom!),
    );

    // --- Allow bridge ---

    await chain2Contract.addBridge(
      otherWarpCoreConfig.tokens[0].addressOrDenom!,
      chain3Metadata.domainId,
    );

    // --- Fund warp route bridge collaterals ---

    await (
      await tokenChain2
        .connect(chain2Signer)
        .transfer(otherWarpCoreConfig.tokens[0].addressOrDenom!, toWei(10))
    ).wait();

    await (
      await tokenChain3
        .connect(chain3Signer)
        .transfer(otherWarpCoreConfig.tokens[1].addressOrDenom!, toWei(10))
    ).wait();

    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      rebalanceStrategy: StrategyOptions.Weighted,
      [CHAIN_NAME_2]: {
        weight: '25',
        tolerance: '0',
        bridge: otherWarpCoreConfig.tokens[0].addressOrDenom!,
        bridgeLockTime: 60000,
        bridgeIsWarp: true,
      },
      [CHAIN_NAME_3]: {
        weight: '75',
        tolerance: '0',
        bridge: otherWarpCoreConfig.tokens[1].addressOrDenom!,
        bridgeLockTime: 60000,
        bridgeIsWarp: true,
      },
    });

    // --- Start relayer ---

    const relayer = hyperlaneRelayer(
      [CHAIN_NAME_2, CHAIN_NAME_3],
      otherWarpDeploymentPath,
    );

    await sleep(2000);

    // --- Start rebalancer ---

    try {
      await startRebalancerAndExpectLog(
        [
          'Rebalancer started successfully 🚀',
          'Found 1 rebalancing route(s) using WeightedStrategy',
          `Populating rebalance transaction: domain=${chain3Metadata.domainId}, amount=5000000000000000000, bridge=${otherWarpCoreConfig.tokens[0].addressOrDenom}`,
          '✅ Rebalance successful',
          'Found 0 rebalancing route(s) using WeightedStrategy.',
          'No routes to execute',
        ],
        { timeout: 30000, checkFrequency: 1000 },
      );
    } finally {
      await relayer.kill();
    }
  });

  describe('manual rebalance', () => {
    it('should successfully rebalance tokens between chains using a mock bridge', async () => {
      const wccTokens = warpCoreConfig.tokens;

      // Contract addresses
      // For this test, rebalance will consist of sending tokens from chain 3 to chain 2
      const originContractAddress = wccTokens[1].addressOrDenom!;
      const destContractAddress = wccTokens[0].addressOrDenom!;

      // Addresses of the wrapped collateral tokens
      const originTknAddress = wccTokens[1].collateralAddressOrDenom!;
      const destTknAddress = wccTokens[0].collateralAddressOrDenom!;

      // Domain IDs
      const originDomain = chain3Metadata.domainId;
      const destDomain = chain2Metadata.domainId;

      // Chain names
      const originName = CHAIN_NAME_3;
      const destName = CHAIN_NAME_2;

      // RPC URLs
      const originRpc = chain3Metadata.rpcUrls[0].http;
      const destRpc = chain2Metadata.rpcUrls[0].http;

      // Assign rebalancer role
      // We need to assign to the contract who is able to send the rebalance transaction
      const originProvider = new ethers.providers.JsonRpcProvider(originRpc);
      const destProvider = new ethers.providers.JsonRpcProvider(destRpc);
      const originSigner = new Wallet(ANVIL_KEY, originProvider);
      const originContract = HypERC20Collateral__factory.connect(
        originContractAddress,
        originSigner,
      );
      const rebalancerRole = await originContract.REBALANCER_ROLE();
      await originContract.grantRole(rebalancerRole, originSigner.address);

      // Allow destination
      // We have to allow for a particular domain (chain 2) that the destination contract is able to receive the tokens
      await originContract.addRecipient(
        destDomain,
        addressToBytes32(destContractAddress),
      );

      // Deploy the bridge
      // This mock contract will be used to allow the rebalance transaction to be sent
      // It will also allow us to mock some token movement
      const bridgeContract = await new MockValueTransferBridge__factory(
        originSigner,
      ).deploy();

      // Allow bridge
      // This allow the bridge to be used to send the rebalance transaction
      await originContract.addBridge(bridgeContract.address, destDomain);

      // Configure rebalancer
      // Given that the rebalance will be performed by sending tokens from chain 3 to chain 2
      // we need to add the address of the allowed bridge to chain 3
      writeYamlOrJson(REBALANCER_CONFIG_PATH, {
        rebalanceStrategy: StrategyOptions.Weighted,
        [CHAIN_NAME_2]: {
          weight: '75',
          tolerance: '0',
          bridge: ethers.constants.AddressZero,
          bridgeTolerance: 1,
          bridgeLockTime: 1,
        },
        [CHAIN_NAME_3]: {
          weight: '25',
          tolerance: '0',
          bridge: bridgeContract.address,
          bridgeTolerance: 1,
          bridgeLockTime: 1,
        },
      });

      // Promise that will resolve with the event that is emitted by the bridge when the rebalance transaction is sent
      const listenForSentTransferRemote = new Promise<{
        origin: Domain;
        destination: Domain;
        recipient: Address;
        amount: bigint;
      }>((resolve) => {
        bridgeContract.on(
          bridgeContract.filters.SentTransferRemote(),
          (origin, destination, recipient, amount) => {
            resolve({
              origin,
              destination,
              recipient: bytes32ToAddress(recipient),
              amount: amount.toBigInt(),
            });

            bridgeContract.removeAllListeners();
          },
        );
      });

      // Start the rebalancer
      const rebalancer = startRebalancer({
        origin: originName,
        destination: destName,
        amount: toWei(5),
      });

      // Await for the event that is emitted when the rebalance is triggered
      const sentTransferRemote = await listenForSentTransferRemote;

      // Verify the different params of the event to make sure that the transfer of 5TKN is being done from chain 3 to chain 2
      expect(sentTransferRemote.origin).to.equal(originDomain);
      expect(sentTransferRemote.destination).to.equal(destDomain);
      expect(sentTransferRemote.recipient).to.equal(destContractAddress);
      expect(sentTransferRemote.amount).to.equal(BigInt(toWei(5)));

      const originTkn = ERC20__factory.connect(
        originTknAddress,
        originProvider,
      );
      const destTkn = ERC20__factory.connect(destTknAddress, destProvider);

      let originBalance = await originTkn.balanceOf(originContractAddress);
      let destBalance = await destTkn.balanceOf(destContractAddress);

      // Verify that the tokens are in the right place before the transfer
      expect(originBalance.toString()).to.equal(toWei(10));
      expect(destBalance.toString()).to.equal(toWei(10));

      // Simulate rebalancing by transferring tokens from destination to origin chain.
      // This process locks tokens on the destination chain and unlocks them on the origin,
      // effectively increasing collateral on the destination while decreasing it on the origin,
      // which achieves the desired rebalancing effect.
      await hyperlaneWarpSendRelay(
        destName,
        originName,
        warpDeploymentPath,
        true,
        sentTransferRemote.amount.toString(),
      );

      originBalance = await originTkn.balanceOf(originContractAddress);
      destBalance = await destTkn.balanceOf(destContractAddress);

      // Verify that the tokens have been rebalanced according their weights defined by the config
      expect(originBalance.toString()).to.equal(toWei(5));
      expect(destBalance.toString()).to.equal(toWei(15));

      // Kill the process to finish the test
      await rebalancer.kill();

      // Running the rebalancer again should not trigger any rebalance given that it is already balanced.
      await startRebalancerAndExpectLog(
        `No routes to execute. Assuming rebalance is complete. Resetting semaphore timer.`,
      );
    });

    it('should use another warp route as bridge', async () => {
      // --- Deploy the other warp route ---

      const otherWarpDeploymentPath = getCombinedWarpRoutePath(tokenSymbol, [
        CHAIN_NAME_2,
        CHAIN_NAME_3,
      ]);
      const otherWarpRouteDeployConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.collateral,
          token: tokenChain2.address,
          mailbox: chain2Addresses.mailbox,
          owner: ANVIL_DEPLOYER_ADDRESS,
        },
        [CHAIN_NAME_3]: {
          type: TokenType.collateral,
          token: tokenChain3.address,
          mailbox: chain3Addresses.mailbox,
          owner: ANVIL_DEPLOYER_ADDRESS,
        },
      };
      writeYamlOrJson(otherWarpDeploymentPath, otherWarpRouteDeployConfig);
      await hyperlaneWarpDeploy(otherWarpDeploymentPath);

      const otherWarpCoreConfig: WarpCoreConfig = readYamlOrJson(
        otherWarpDeploymentPath,
      );

      const chain2Signer = new Wallet(
        ANVIL_KEY,
        new ethers.providers.JsonRpcProvider(chain2Metadata.rpcUrls[0].http),
      );

      const chain3Signer = new Wallet(
        ANVIL_KEY,
        new ethers.providers.JsonRpcProvider(chain3Metadata.rpcUrls[0].http),
      );

      const chain2Contract = HypERC20Collateral__factory.connect(
        warpCoreConfig.tokens[0].addressOrDenom!,
        chain2Signer,
      );

      // --- Grant rebalancer role ---

      await chain2Contract.grantRole(
        await chain2Contract.REBALANCER_ROLE(),
        chain2Signer.address,
      );

      // --- Allow destination ---

      await chain2Contract.addRecipient(
        chain3Metadata.domainId,
        addressToBytes32(warpCoreConfig.tokens[1].addressOrDenom!),
      );

      // --- Allow bridge ---

      await chain2Contract.addBridge(
        otherWarpCoreConfig.tokens[0].addressOrDenom!,
        chain3Metadata.domainId,
      );

      // --- Fund warp route bridge collaterals ---

      await (
        await tokenChain2
          .connect(chain2Signer)
          .transfer(otherWarpCoreConfig.tokens[0].addressOrDenom!, toWei(10))
      ).wait();

      await (
        await tokenChain3
          .connect(chain3Signer)
          .transfer(otherWarpCoreConfig.tokens[1].addressOrDenom!, toWei(10))
      ).wait();

      writeYamlOrJson(REBALANCER_CONFIG_PATH, {
        rebalanceStrategy: StrategyOptions.Weighted,
        [CHAIN_NAME_2]: {
          weight: '25',
          tolerance: '0',
          bridge: otherWarpCoreConfig.tokens[0].addressOrDenom!,
          bridgeTolerance: 60000,
          bridgeIsWarp: true,
          bridgeLockTime: 1,
        },
        [CHAIN_NAME_3]: {
          weight: '75',
          tolerance: '0',
          bridge: otherWarpCoreConfig.tokens[1].addressOrDenom!,
          bridgeTolerance: 60000,
          bridgeIsWarp: true,
          bridgeLockTime: 1,
        },
      });

      // --- Start relayer ---

      const relayer = hyperlaneRelayer(
        [CHAIN_NAME_2, CHAIN_NAME_3],
        otherWarpDeploymentPath,
      );

      await sleep(2000);

      // --- Start rebalancer ---

      try {
        await startRebalancerAndExpectLog(
          [
            'Calculating rebalancing routes using WeightedStrategy...',
            'Found 1 rebalancing route(s) using WeightedStrategy.',
          ],
          { monitorOnly: true },
        );

        await startRebalancerAndExpectLog(
          [
            'Rebalance initiated with 1 route(s)',
            `Populating rebalance transaction: domain=${chain3Metadata.domainId}, amount=5000000000000000000, bridge=${otherWarpCoreConfig.tokens[0].addressOrDenom}`,
            `Route result - Origin: ${CHAIN_NAME_2}, Destination: ${CHAIN_NAME_3}, Amount: 5000000000000000000`,
            '✅ Rebalance successful',
          ],
          {
            timeout: 30000,
            origin: CHAIN_NAME_2,
            destination: CHAIN_NAME_3,
            amount: toWei(5),
          },
        );

        await startRebalancerAndExpectLog(
          [
            'Calculating rebalancing routes using WeightedStrategy...',
            'Found 0 rebalancing route(s) using WeightedStrategy.',
          ],
          { timeout: 90000, monitorOnly: true },
        );
      } finally {
        await relayer.kill();
      }
    });
  });
});
