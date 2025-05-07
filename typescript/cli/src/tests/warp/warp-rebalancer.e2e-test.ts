import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet, ethers } from 'ethers';
import { rmSync } from 'fs';
import { $ } from 'zx';

import {
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

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
  ANVIL_ADDRESS,
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
  restoreSnapshot,
} from '../commands/helpers.js';
import {
  hyperlaneWarpDeploy,
  hyperlaneWarpRebalancer,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
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

  before(async () => {
    ogVerbose = $.verbose;
    $.verbose = false;

    console.log('Deploying core contracts on all chains...');

    const [chain2Addresses, chain3Addresses, chain4Addresses] =
      await Promise.all([
        deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
        deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
        deployOrUseExistingCore(CHAIN_NAME_4, CORE_CONFIG_PATH, ANVIL_KEY),
      ]);

    console.log('Deploying ERC20s...');

    const [tokenChain2, tokenChain3] = await Promise.all([
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
        owner: ANVIL_ADDRESS,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.collateral,
        token: tokenChain3.address,
        mailbox: chain3Addresses.mailbox,
        owner: ANVIL_ADDRESS,
      },
      [CHAIN_NAME_4]: {
        type: TokenType.synthetic,
        mailbox: chain4Addresses.mailbox,
        owner: ANVIL_ADDRESS,
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
      sleep(1000).then(() =>
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
      [CHAIN_NAME_2]: {
        weight: '100',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
      },
      [CHAIN_NAME_3]: {
        weight: '100',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
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

  function startRebalancer(options: { withMetrics?: boolean } = {}) {
    const { withMetrics = false } = options;

    return hyperlaneWarpRebalancer(
      warpRouteId,
      CHECK_FREQUENCY,
      REBALANCER_CONFIG_PATH,
      withMetrics,
    );
  }

  async function startRebalancerAndExpectLog(
    log: string,
    options: { timeout?: number; withMetrics?: boolean } = {},
  ) {
    const { timeout = 10_000, withMetrics = false } = options;

    const process = startRebalancer({ withMetrics });

    let timeoutId: NodeJS.Timeout;

    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      // Use a timeout to prevent waiting for a log that might never happen and fail faster
      timeoutId = setTimeout(async () => {
        reject(new Error(`Timeout waiting for log: "${log}"`));
      }, timeout);

      // Handle when the process exits due to an error that is not the expected log
      process.catch((e) => {
        const lines = e.lines();
        const error = lines[lines.length - 1];

        reject(
          new Error(
            `Process failed before logging: "${log}" with error: ${error}`,
          ),
        );
      });

      // Wait for the process to output the expected log.
      for await (let chunk of process.stdout) {
        chunk = typeof chunk === 'string' ? chunk : chunk.toString();

        if (chunk.includes(log)) {
          resolve(void 0);
          break;
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
      [CHAIN_NAME_2]: {
        weight: 'weight',
        tolerance: 0,
        bridge: ethers.constants.AddressZero,
      },
      [CHAIN_NAME_3]: {
        weight: 100,
        tolerance: 0,
        bridge: ethers.constants.AddressZero,
      },
    });

    await startRebalancerAndExpectLog(`Cannot convert weight to a BigInt`);
  });

  it('should throw if a tolerance value cannot be parsed as bigint', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      [CHAIN_NAME_2]: {
        weight: 100,
        tolerance: 0,
        bridge: ethers.constants.AddressZero,
      },
      [CHAIN_NAME_3]: {
        weight: 100,
        tolerance: 'tolerance',
        bridge: ethers.constants.AddressZero,
      },
    });

    await startRebalancerAndExpectLog(`Cannot convert tolerance to a BigInt`);
  });

  it('should throw if a bridge value is not a valid address', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      [CHAIN_NAME_2]: {
        weight: 100,
        tolerance: 0,
        bridge: 'bridge',
      },
      [CHAIN_NAME_3]: {
        weight: 100,
        tolerance: 0,
        bridge: ethers.constants.AddressZero,
      },
    });

    await startRebalancerAndExpectLog(
      `Validation error: Invalid at "anvil2.bridge"`,
    );
  });

  it('should log that no routes are to be executed', async () => {
    await startRebalancerAndExpectLog(`No routes to execute`);
  });

  it('should not rebalance if mode is monitorOnly', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      monitorOnly: true,
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
      },
    });

    await startRebalancerAndExpectLog(
      `No rebalance executed in monitorOnly mode`,
    );
  });

  it('should throw if key does not belong to the assigned rebalancer', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
      },
    });

    await startRebalancerAndExpectLog(
      `Signer ${ANVIL_ADDRESS} is not a rebalancer`,
    );
  });

  it('should throw if the destination is not allowed', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
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
      } is not allowed`,
    );
  });

  it('should throw if the bridge is not allowed', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
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
      `Bridge ${ethers.constants.AddressZero} for domain ${chain2Metadata.domainId} is not allowed`,
    );
  });

  it('should throw if the bridge does not have a valid transferRemote function', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
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

    await startRebalancerAndExpectLog('❌ Some rebalance transaction failed');
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
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: bridgeContract.address,
      },
    });

    await startRebalancerAndExpectLog('✅ Rebalance successful');
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
      addressToBytes32(originContractAddress),
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
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: bridgeContract.address,
      },
    });

    // Promise that will resolve with the event that is emited by the bridge when the rebalance transaction is sent
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
    const rebalancer = hyperlaneWarpRebalancer(
      warpRouteId,
      CHECK_FREQUENCY,
      REBALANCER_CONFIG_PATH,
      false,
    );

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
    await startRebalancerAndExpectLog(`No routes to execute`);
  });

  it('should successfully log metrics tracking', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      [CHAIN_NAME_2]: {
        weight: '75',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
      },
      [CHAIN_NAME_3]: {
        weight: '25',
        tolerance: '0',
        bridge: ethers.constants.AddressZero,
      },
    });

    await startRebalancerAndExpectLog(
      `"module":"warp-balance-monitor","labels":{"chain_name":"anvil4","token_address":"0x59b670e9fA9D0A427751Af201D676719a970857b","token_name":"token","wallet_address":"0x59b670e9fA9D0A427751Af201D676719a970857b","token_standard":"EvmHypSynthetic","warp_route_id":"TOKEN/anvil2-anvil3-anvil4","related_chain_names":"anvil2,anvil3"},"balance":20,"msg":"Wallet balance updated for token"`,
      { withMetrics: true },
    );
  });

  it('should start the metrics server and expose prometheus metrics', async () => {
    const process = startRebalancer({ withMetrics: true });

    // Give the server some time to start
    await sleep(3000);

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
    await sleep(3000);

    // Check that metrics endpoint is not responding
    return fetch(DEFAULT_METRICS_SERVER).should.be.rejected.then(() =>
      process.kill(),
    );
  });
});
