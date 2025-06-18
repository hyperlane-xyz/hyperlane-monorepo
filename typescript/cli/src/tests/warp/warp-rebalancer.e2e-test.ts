import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet, ethers } from 'ethers';
import { rmSync } from 'fs';
import { $, ProcessPromise } from 'zx';

import {
  ERC20,
  ERC20__factory,
  HypERC20Collateral__factory,
  MockValueTransferBridge__factory,
} from '@hyperlane-xyz/core';
import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  RebalancerMinAmountType,
  RebalancerStrategyOptions,
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
  REGISTRY_PATH,
  createSnapshot,
  deployOrUseExistingCore,
  deployToken,
  getTokenAddressFromWarpConfig,
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
  let warpCoreConfigPath: string;

  let warpCoreConfig: WarpCoreConfig;
  let chain2Metadata: ChainMetadata;
  let chain3Metadata: ChainMetadata;
  let chain4Metadata: ChainMetadata;

  let chain2Addresses: Record<string, string>;
  let chain3Addresses: Record<string, string>;
  let chain4Addresses: Record<string, string>;

  let tokenChain2: ERC20;
  let tokenChain3: ERC20;

  let warpRouteDeployConfig: WarpRouteDeployConfig;

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

    // Generate the base path for warp configs
    warpRouteId = createWarpRouteConfigId(
      tokenSymbol,
      [CHAIN_NAME_2, CHAIN_NAME_3, CHAIN_NAME_4].sort().join('-'),
    );
    const basePath = `${REGISTRY_PATH}/deployments/warp_routes/${warpRouteId}`;

    // Separate paths for deploy and core configs
    warpDeploymentPath = `${basePath}-deploy.yaml`;
    warpCoreConfigPath = `${basePath}-config.yaml`;

    warpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: tokenChain2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ANVIL_DEPLOYER_ADDRESS,
        allowedRebalancers: [ANVIL_DEPLOYER_ADDRESS],
      },
      [CHAIN_NAME_3]: {
        type: TokenType.collateral,
        token: tokenChain3.address,
        mailbox: chain3Addresses.mailbox,
        owner: ANVIL_DEPLOYER_ADDRESS,
        allowedRebalancers: [ANVIL_DEPLOYER_ADDRESS],
      },
      [CHAIN_NAME_4]: {
        type: TokenType.synthetic,
        mailbox: chain4Addresses.mailbox,
        owner: ANVIL_DEPLOYER_ADDRESS,
      },
    };
    writeYamlOrJson(warpDeploymentPath, warpRouteDeployConfig);
    await hyperlaneWarpDeploy(warpDeploymentPath, warpRouteId);

    // After deployment, read the core config that was generated
    warpCoreConfig = readYamlOrJson(warpCoreConfigPath);
    chain2Metadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    chain3Metadata = readYamlOrJson(CHAIN_3_METADATA_PATH);
    chain4Metadata = readYamlOrJson(CHAIN_4_METADATA_PATH);

    console.log('Bridging tokens...');

    await Promise.all([
      hyperlaneWarpSendRelay(
        CHAIN_NAME_2,
        CHAIN_NAME_4,
        warpCoreConfigPath,
        true,
        toWei(10),
      ),
      sleep(2000).then(() =>
        hyperlaneWarpSendRelay(
          CHAIN_NAME_3,
          CHAIN_NAME_4,
          warpCoreConfigPath,
          true,
          toWei(10),
        ),
      ),
    ]);
  });

  after(() => {
    $.verbose = ogVerbose;
  });

  beforeEach(async () => {
    // This is a workaround for the global e2e-test.setup.ts which cleans up
    // the warp route configs before each test.
    writeYamlOrJson(warpDeploymentPath, warpRouteDeployConfig);
    writeYamlOrJson(warpCoreConfigPath, warpCoreConfig);

    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '100',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '100',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
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
      monitorOnly?: boolean;
      manual?: boolean;
      origin?: string;
      destination?: string;
      amount?: string;
      key?: string;
    } = {},
  ): ProcessPromise {
    const {
      checkFrequency = CHECK_FREQUENCY,
      withMetrics = false,
      monitorOnly = false,
      manual = false,
      origin,
      destination,
      amount,
      key,
    } = options;

    return hyperlaneWarpRebalancer(
      checkFrequency,
      REBALANCER_CONFIG_PATH,
      withMetrics,
      monitorOnly,
      manual,
      origin,
      destination,
      amount,
      key,
    );
  }

  async function startRebalancerAndExpectLog(
    log: string | string[],
    options: {
      timeout?: number;
      checkFrequency?: number;
      withMetrics?: boolean;
      monitorOnly?: boolean;
      manual?: boolean;
      origin?: string;
      destination?: string;
      amount?: string;
      key?: string;
    } = {},
  ) {
    const {
      timeout = 10_000,
      checkFrequency,
      withMetrics,
      monitorOnly,
      manual,
      origin,
      destination,
      amount,
      key,
    } = options;

    const rebalancer = startRebalancer({
      checkFrequency,
      withMetrics,
      monitorOnly,
      manual,
      origin,
      destination,
      amount,
      key,
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

    return new Promise((resolve, reject) => {
      // Use a timeout to prevent waiting for a log that might never happen and fail faster
      timeoutId = setTimeout(() => {
        reject(new Error(`Timeout waiting for log: "${expectedLogs[0]}"`));
      }, timeout);

      // Handle when the process exits due to an error that is not the expected log
      rebalancer.catch((e) => {
        const lines = e.lines();
        const error = lines[lines.length - 1];

        clearTimeout(timeoutId);
        reject(
          new Error(
            `Process failed before logging: "${expectedLogs[0]}" with error: ${error}`,
          ),
        );
      });
      (async () => {
        // Wait for the process to output the expected log.
        for await (let chunk of rebalancer.stdout) {
          chunk = typeof chunk === 'string' ? chunk : chunk.toString();
          const lines = chunk.split('\n').filter(Boolean); // handle empty lines

          for (const line of lines) {
            if (!expectedLogs.length) break;
            try {
              const logJson = JSON.parse(line);
              if (logJson.msg?.includes(expectedLogs[0])) {
                expectedLogs.shift();
              }
            } catch (_e) {
              // For non-json logs
              if (line.includes(expectedLogs[0])) {
                expectedLogs.shift();
              }
            }
          }

          if (!expectedLogs.length) {
            resolve(void 0);
            break;
          }
        }
      })().catch(reject);
    }).finally(async () => {
      // Perform a cleanup at the end
      clearTimeout(timeoutId);
      // Kill the process and wait for it to exit to prevent hangs
      await rebalancer.kill('SIGINT');
    });
  }

  it('should successfully start the rebalancer', async () => {
    await startRebalancerAndExpectLog('Rebalancer started successfully 🚀');
  });

  it('should throw when strategy config file does not exist', async () => {
    rmSync(REBALANCER_CONFIG_PATH);

    await startRebalancerAndExpectLog(
      `Rebalancer startup error: Error: File doesn't exist at ${REBALANCER_CONFIG_PATH}`,
    );
  });

  it(`should throw if there's a mix of minAmount types`, async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
        chains: {
          [CHAIN_NAME_2]: {
            minAmount: {
              min: 9,
              target: 10,
              type: RebalancerMinAmountType.Absolute,
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            minAmount: {
              min: 0.5,
              target: 0.55,
              type: RebalancerMinAmountType.Relative,
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
      },
    });

    await startRebalancerAndExpectLog(
      `Rebalancer startup error: Error: Validation error: All chains must use the same minAmount type. at "strategy.chains"`,
    );
  });

  it('should throw if a weight value cannot be parsed as bigint', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: 'weight',
              tolerance: 0,
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: 100,
              tolerance: 0,
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
      },
    });

    await startRebalancerAndExpectLog(
      `Rebalancer startup error: SyntaxError: Cannot convert weight to a BigInt`,
    );
  });

  it('should throw if a tolerance value cannot be parsed as bigint', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: 100,
              tolerance: 0,
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: 100,
              tolerance: 'tolerance',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
      },
    });

    await startRebalancerAndExpectLog(
      `Rebalancer startup error: SyntaxError: Cannot convert tolerance to a BigInt`,
    );
  });

  it('should throw if a bridge value is not a valid address', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: 100,
              tolerance: 0,
            },
            bridge: 'bridge',
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: 100,
              tolerance: 0,
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
      },
    });

    await startRebalancerAndExpectLog(
      `Rebalancer startup error: Error: Validation error: Invalid at "strategy.chains.anvil2.bridge"`,
    );
  });

  it('should log that no routes are to be executed', async () => {
    await startRebalancerAndExpectLog(
      `No routes to execute. Assuming rebalance is complete. Resetting semaphore timer.`,
    );
  });

  it('should not rebalance if mode is monitorOnly', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
      },
    });

    await startRebalancerAndExpectLog(
      `Running in monitorOnly mode: no transactions will be executed.`,
      { monitorOnly: true },
    );
  });

  it('should skip chains that are not in the config', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
      },
    });

    await startRebalancerAndExpectLog(
      `Skipping token: not in configured chains list`,
    );
  });

  it('should skip chains that are not supported collaterals', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_4]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
      },
    });

    await startRebalancerAndExpectLog(
      `Skipping token: not collateralized or ineligible for rebalancing`,
    );
  });

  it('should throw if key does not belong to the assigned rebalancer', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
      },
    });

    // Generate a random key that is not a rebalancer
    const randomKey = Wallet.createRandom().privateKey;

    await startRebalancerAndExpectLog(
      `Route validation failed: Signer is not a rebalancer`,
      { key: randomKey },
    );
  });

  it('should throw if the destination is not allowed', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
      },
    });

    // Assign rebalancer role
    const chain3Provider = new ethers.providers.JsonRpcProvider(
      chain3Metadata.rpcUrls[0].http,
    );
    const chain3Signer = new Wallet(ANVIL_KEY, chain3Provider);
    const chain3CollateralContract = HypERC20Collateral__factory.connect(
      getTokenAddressFromWarpConfig(warpCoreConfig, CHAIN_NAME_3),
      chain3Signer,
    );

    // Disallow destination by setting it to a random, non-zero address
    await chain3CollateralContract.setRecipient(
      chain2Metadata.domainId,
      addressToBytes32(ethers.Wallet.createRandom().address),
    );

    await startRebalancerAndExpectLog(
      'Route validation failed: Destination is not allowed.',
    );
  });

  it('should throw if the bridge is not allowed', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
      },
    });

    await startRebalancerAndExpectLog(
      'Route validation failed: Bridge is not allowed.',
    );
  });

  it('should throw if rebalance quotes cannot be obtained', async () => {
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
      },
    });

    // Assign rebalancer role
    const chain3Provider = new ethers.providers.JsonRpcProvider(
      chain3Metadata.rpcUrls[0].http,
    );
    const chain3Signer = new Wallet(ANVIL_KEY, chain3Provider);
    const chain3CollateralContract = HypERC20Collateral__factory.connect(
      getTokenAddressFromWarpConfig(warpCoreConfig, CHAIN_NAME_3),
      chain3Signer,
    );

    // Allow bridge
    await chain3CollateralContract.addBridge(
      chain2Metadata.domainId,
      ethers.constants.AddressZero,
    );

    await startRebalancerAndExpectLog('Failed to get quotes for route.');
  });

  it('should throw if the sum of minAmount targets is more than sum of collaterals', async () => {
    // Assign rebalancer role
    const chain3Provider = new ethers.providers.JsonRpcProvider(
      chain3Metadata.rpcUrls[0].http,
    );
    const chain3Signer = new Wallet(ANVIL_KEY, chain3Provider);
    const chain3CollateralContract = HypERC20Collateral__factory.connect(
      getTokenAddressFromWarpConfig(warpCoreConfig, CHAIN_NAME_3),
      chain3Signer,
    );

    // Deploy the bridge
    const bridgeContract = await new MockValueTransferBridge__factory(
      chain3Signer,
    ).deploy();

    // Allow bridge
    await chain3CollateralContract.addBridge(
      chain2Metadata.domainId,
      bridgeContract.address,
    );

    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.MinAmount,
        chains: {
          [CHAIN_NAME_2]: {
            minAmount: {
              min: 7,
              target: 11,
              type: RebalancerMinAmountType.Absolute,
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            minAmount: {
              min: 8,
              target: 12,
              type: RebalancerMinAmountType.Absolute,
            },
            bridge: bridgeContract.address,
            bridgeLockTime: 1,
          },
        },
      },
    });

    await startRebalancerAndExpectLog(
      `Rebalancer startup error: Error: Consider reducing the targets as the sum (23) is greater than sum of collaterals (20)`,
    );
  });

  it('should successfully send rebalance transaction', async () => {
    // Assign rebalancer role
    const chain3Provider = new ethers.providers.JsonRpcProvider(
      chain3Metadata.rpcUrls[0].http,
    );
    const chain3Signer = new Wallet(ANVIL_KEY, chain3Provider);
    const chain3CollateralContract = HypERC20Collateral__factory.connect(
      getTokenAddressFromWarpConfig(warpCoreConfig, CHAIN_NAME_3),
      chain3Signer,
    );

    // Deploy the bridge
    const bridgeContract = await new MockValueTransferBridge__factory(
      chain3Signer,
    ).deploy();

    // Allow bridge
    await chain3CollateralContract.addBridge(
      chain2Metadata.domainId,
      bridgeContract.address,
    );

    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: bridgeContract.address,
            bridgeLockTime: 1,
          },
        },
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
      getTokenAddressFromWarpConfig(warpCoreConfig, CHAIN_NAME_3),
      chain3Signer,
    );

    // Deploy the bridge
    const bridgeContract = await new MockValueTransferBridge__factory(
      chain3Signer,
    ).deploy();

    // Allow bridge
    await chain3CollateralContract.addBridge(
      chain2Metadata.domainId,
      bridgeContract.address,
    );

    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: bridgeContract.address,
            bridgeLockTime: 1,
            bridgeMinAcceptedAmount: '5.000001',
          },
        },
      },
    });

    await startRebalancerAndExpectLog(
      'Route skipped due to minimum threshold amount not met.',
    );
  });

  // TODO: this test is failing, but it's not clear why
  it('should successfully rebalance tokens between chains using a mock bridge', async () => {
    const wccTokens = warpCoreConfig.tokens;

    // Contract addresses
    // For this test, rebalance will consist of sending tokens from chain 3 to chain 2
    const originContractAddress = getTokenAddressFromWarpConfig(
      warpCoreConfig,
      CHAIN_NAME_3,
    );
    const destContractAddress = getTokenAddressFromWarpConfig(
      warpCoreConfig,
      CHAIN_NAME_2,
    );

    // Addresses of the wrapped collateral tokens
    const originTknAddress = wccTokens.find(
      (t) => t.chainName === CHAIN_NAME_3,
    )!.collateralAddressOrDenom!;
    const destTknAddress = wccTokens.find(
      (t) => t.chainName === CHAIN_NAME_2,
    )!.collateralAddressOrDenom!;

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

    // Deploy the bridge
    // This mock contract will be used to allow the rebalance transaction to be sent
    // It will also allow us to mock some token movement
    const bridgeContract = await new MockValueTransferBridge__factory(
      originSigner,
    ).deploy();

    // Allow bridge
    // This allow the bridge to be used to send the rebalance transaction
    await originContract.addBridge(destDomain, bridgeContract.address);

    // Configure rebalancer
    // Given that the rebalance will be performed by sending tokens from chain 3 to chain 2
    // we need to add the address of the allowed bridge to chain 3
    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: bridgeContract.address,
            bridgeLockTime: 1,
          },
        },
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
      warpCoreConfigPath,
      true,
      sentTransferRemote.amount.toString(),
    );

    originBalance = await originTkn.balanceOf(originContractAddress);
    destBalance = await destTkn.balanceOf(destContractAddress);

    // Verify that the tokens have been rebalanced according their weights defined by the config
    expect(originBalance.toString()).to.equal(toWei(5));
    expect(destBalance.toString()).to.equal(toWei(15));

    // Kill the process to finish the test
    await rebalancer.kill('SIGINT');

    // Running the rebalancer again should not trigger any rebalance given that it is already balanced.
    await startRebalancerAndExpectLog(
      `No routes to execute. Assuming rebalance is complete. Resetting semaphore timer.`,
    );
  });

  // TODO: this test is failing, but it's not clear why
  it('should throw when the semaphore timer has not expired', async () => {
    const originContractAddress = getTokenAddressFromWarpConfig(
      warpCoreConfig,
      CHAIN_NAME_3,
    );
    const destDomain = chain2Metadata.domainId;
    const originRpc = chain3Metadata.rpcUrls[0].http;

    const originProvider = new ethers.providers.JsonRpcProvider(originRpc);
    const originSigner = new Wallet(ANVIL_KEY, originProvider);
    const originContract = HypERC20Collateral__factory.connect(
      originContractAddress,
      originSigner,
    );

    // --- Deploy the bridge ---

    const bridgeContract = await new MockValueTransferBridge__factory(
      originSigner,
    ).deploy();

    // --- Allow bridge ---

    await originContract.addBridge(destDomain, bridgeContract.address);

    // --- Configure rebalancer ---

    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 100,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: bridgeContract.address,
            bridgeLockTime: 100,
          },
        },
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
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: ethers.constants.AddressZero,
            bridgeLockTime: 1,
          },
        },
      },
    });

    await startRebalancerAndExpectLog('Wallet balance updated for token', {
      withMetrics: true,
    });
  });

  it('should not find any metrics server when metrics are not enabled', async () => {
    const rebalancer = startRebalancer({ withMetrics: false });

    // TODO: find a deterministic approach to this, as it may fail due to resource restrictions
    // Give the server some time to start, but we don't need to wait long as we expect it to fail
    await sleep(1000);

    // Check that metrics endpoint is not responding
    await expect(fetch(DEFAULT_METRICS_SERVER)).to.be.rejected;

    await rebalancer.kill('SIGINT');
  });

  it('should start the metrics server and expose prometheus metrics', async () => {
    const rebalancer = startRebalancer({ withMetrics: true });

    await sleep(3500);
    try {
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
    } finally {
      await rebalancer.kill('SIGINT');
    }
  });

  it('should use another warp route as bridge', async () => {
    // --- Deploy the other warp route ---

    const otherWarpRouteId = createWarpRouteConfigId(
      tokenSymbol,
      [CHAIN_NAME_2, CHAIN_NAME_3].sort().join('-'),
    );
    const otherWarpDeployConfigPath = `${REGISTRY_PATH}/deployments/warp_routes/${otherWarpRouteId}-deploy.yaml`;
    const otherWarpCoreConfigPath = `${REGISTRY_PATH}/deployments/warp_routes/${otherWarpRouteId}-config.yaml`;

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
    writeYamlOrJson(otherWarpDeployConfigPath, otherWarpRouteDeployConfig);
    await hyperlaneWarpDeploy(otherWarpDeployConfigPath, otherWarpRouteId);

    const otherWarpCoreConfig: WarpCoreConfig = readYamlOrJson(
      otherWarpCoreConfigPath,
    );

    const chain2BridgeAddress = getTokenAddressFromWarpConfig(
      otherWarpCoreConfig,
      CHAIN_NAME_2,
    );
    const chain3BridgeAddress = getTokenAddressFromWarpConfig(
      otherWarpCoreConfig,
      CHAIN_NAME_3,
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
      getTokenAddressFromWarpConfig(warpCoreConfig, CHAIN_NAME_2),
      chain2Signer,
    );

    const chain3Contract = HypERC20Collateral__factory.connect(
      getTokenAddressFromWarpConfig(warpCoreConfig, CHAIN_NAME_3),
      chain3Signer,
    );

    // --- Allow bridge ---

    await chain2Contract.addBridge(
      chain3Metadata.domainId,
      chain2BridgeAddress,
    );

    await chain3Contract.addBridge(
      chain2Metadata.domainId,
      chain3BridgeAddress,
    );

    // --- Fund warp route bridge collaterals ---
    await (
      await tokenChain2
        .connect(chain2Signer)
        .transfer(chain2BridgeAddress, toWei(10))
    ).wait();

    await (
      await tokenChain3
        .connect(chain3Signer)
        .transfer(chain3BridgeAddress, toWei(10))
    ).wait();

    writeYamlOrJson(REBALANCER_CONFIG_PATH, {
      warpRouteId,
      strategy: {
        rebalanceStrategy: RebalancerStrategyOptions.Weighted,
        chains: {
          [CHAIN_NAME_2]: {
            weighted: {
              weight: '25',
              tolerance: '0',
            },
            bridge: chain2BridgeAddress,
            bridgeLockTime: 60,
            bridgeIsWarp: true,
          },
          [CHAIN_NAME_3]: {
            weighted: {
              weight: '75',
              tolerance: '0',
            },
            bridge: chain3BridgeAddress,
            bridgeLockTime: 60,
            bridgeIsWarp: true,
          },
        },
      },
    });

    // --- Start relayer ---
    const relayer = hyperlaneRelayer(
      [CHAIN_NAME_2, CHAIN_NAME_3],
      otherWarpCoreConfigPath,
    );

    await sleep(2000);

    // --- Start rebalancer ---
    try {
      await startRebalancerAndExpectLog(
        [
          'Rebalancer started successfully 🚀',
          'Found rebalancing routes',
          'Preparing all rebalance transactions.',
          'Preparing transaction for route',
          'Estimating gas for all prepared transactions.',
          'Sending valid transactions.',
          'Sending transaction for route',
          'Transaction confirmed for route.',
          '✅ Rebalance successful',
          'No routes to execute',
        ],
        { timeout: 30000, checkFrequency: 1000 },
      );
    } finally {
      await relayer.kill('SIGINT');
    }
  });

  describe('manual rebalance', () => {
    it('should successfully rebalance tokens between chains using a mock bridge', async () => {
      const wccTokens = warpCoreConfig.tokens;

      // Contract addresses
      // For this test, rebalance will consist of sending tokens from chain 3 to chain 2
      const originContractAddress = getTokenAddressFromWarpConfig(
        warpCoreConfig,
        CHAIN_NAME_3,
      );
      const destContractAddress = getTokenAddressFromWarpConfig(
        warpCoreConfig,
        CHAIN_NAME_2,
      );

      // Addresses of the wrapped collateral tokens
      const originTknAddress = wccTokens.find(
        (t) => t.chainName === CHAIN_NAME_3,
      )!.collateralAddressOrDenom!;
      const destTknAddress = wccTokens.find(
        (t) => t.chainName === CHAIN_NAME_2,
      )!.collateralAddressOrDenom!;

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

      // Deploy the bridge
      // This mock contract will be used to allow the rebalance transaction to be sent
      // It will also allow us to mock some token movement
      const bridgeContract = await new MockValueTransferBridge__factory(
        originSigner,
      ).deploy();

      // Allow bridge
      // This allow the bridge to be used to send the rebalance transaction
      await originContract.addBridge(destDomain, bridgeContract.address);

      // Configure rebalancer
      // Given that the rebalance will be performed by sending tokens from chain 3 to chain 2
      // we need to add the address of the allowed bridge to chain 3
      writeYamlOrJson(REBALANCER_CONFIG_PATH, {
        warpRouteId,
        strategy: {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            [CHAIN_NAME_2]: {
              weighted: {
                weight: '75',
                tolerance: '0',
              },
              bridge: ethers.constants.AddressZero,
              bridgeLockTime: 1,
            },
            [CHAIN_NAME_3]: {
              weighted: {
                weight: '25',
                tolerance: '0',
              },
              bridge: bridgeContract.address,
              bridgeLockTime: 1,
            },
          },
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

      const manualRebalanceAmount = '5';

      // Start the rebalancer
      const rebalancer = startRebalancer({
        manual: true,
        origin: originName,
        destination: destName,
        amount: manualRebalanceAmount,
      });

      // Await for the event that is emitted when the rebalance is triggered
      const sentTransferRemote = await listenForSentTransferRemote;

      // Verify the different params of the event to make sure that the transfer of 5TKN is being done from chain 3 to chain 2
      expect(sentTransferRemote.origin).to.equal(originDomain);
      expect(sentTransferRemote.destination).to.equal(destDomain);
      expect(sentTransferRemote.recipient).to.equal(destContractAddress);
      expect(sentTransferRemote.amount).to.equal(
        BigInt(toWei(manualRebalanceAmount)),
      );

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
        warpCoreConfigPath,
        true,
        sentTransferRemote.amount.toString(),
      );

      originBalance = await originTkn.balanceOf(originContractAddress);
      destBalance = await destTkn.balanceOf(destContractAddress);

      // Verify that the tokens have been rebalanced according their weights defined by the config
      expect(originBalance.toString()).to.equal(
        toWei(10 - Number(manualRebalanceAmount)),
      );
      expect(destBalance.toString()).to.equal(
        toWei(10 + Number(manualRebalanceAmount)),
      );

      // Kill the process to finish the test
      await rebalancer.kill('SIGINT');

      // Running the rebalancer again should not trigger any rebalance given that it is already balanced.
      await startRebalancerAndExpectLog(
        `No routes to execute. Assuming rebalance is complete. Resetting semaphore timer.`,
      );
    });

    it('should use another warp route as bridge', async () => {
      // --- Deploy the other warp route ---

      const otherWarpRouteId = createWarpRouteConfigId(
        tokenSymbol,
        [CHAIN_NAME_2, CHAIN_NAME_3].sort().join('-'),
      );
      const otherWarpDeployConfigPath = `${REGISTRY_PATH}/deployments/warp_routes/${otherWarpRouteId}-deploy.yaml`;
      const otherWarpCoreConfigPath = `${REGISTRY_PATH}/deployments/warp_routes/${otherWarpRouteId}-config.yaml`;

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
      writeYamlOrJson(otherWarpDeployConfigPath, otherWarpRouteDeployConfig);
      await hyperlaneWarpDeploy(otherWarpDeployConfigPath, otherWarpRouteId);

      const otherWarpCoreConfig: WarpCoreConfig = readYamlOrJson(
        otherWarpCoreConfigPath,
      );

      const chain2BridgeAddress = getTokenAddressFromWarpConfig(
        otherWarpCoreConfig,
        CHAIN_NAME_2,
      );
      const chain3BridgeAddress = getTokenAddressFromWarpConfig(
        otherWarpCoreConfig,
        CHAIN_NAME_3,
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
        getTokenAddressFromWarpConfig(warpCoreConfig, CHAIN_NAME_2),
        chain2Signer,
      );

      const chain3Contract = HypERC20Collateral__factory.connect(
        getTokenAddressFromWarpConfig(warpCoreConfig, CHAIN_NAME_3),
        chain3Signer,
      );

      // --- Allow bridge ---

      await chain2Contract.addBridge(
        chain3Metadata.domainId,
        chain2BridgeAddress,
      );

      await chain3Contract.addBridge(
        chain2Metadata.domainId,
        chain3BridgeAddress,
      );

      // --- Fund warp route bridge collaterals ---
      await (
        await tokenChain2
          .connect(chain2Signer)
          .transfer(chain2BridgeAddress, toWei(10))
      ).wait();

      await (
        await tokenChain3
          .connect(chain3Signer)
          .transfer(chain3BridgeAddress, toWei(10))
      ).wait();

      writeYamlOrJson(REBALANCER_CONFIG_PATH, {
        warpRouteId,
        strategy: {
          rebalanceStrategy: RebalancerStrategyOptions.Weighted,
          chains: {
            [CHAIN_NAME_2]: {
              weighted: {
                weight: '25',
                tolerance: '0',
              },
              bridge: chain2BridgeAddress,
              bridgeLockTime: 60,
              bridgeIsWarp: true,
            },
            [CHAIN_NAME_3]: {
              weighted: {
                weight: '75',
                tolerance: '0',
              },
              bridge: chain3BridgeAddress,
              bridgeLockTime: 60,
              bridgeIsWarp: true,
            },
          },
        },
      });

      // --- Start relayer ---
      const relayer = hyperlaneRelayer(
        [CHAIN_NAME_2, CHAIN_NAME_3],
        otherWarpCoreConfigPath,
      );

      await sleep(2000);

      // --- Start rebalancer ---
      try {
        await startRebalancerAndExpectLog(
          ['Calculating rebalancing routes', 'Found rebalancing routes'],
          {
            monitorOnly: true,
          },
        );

        const manualRebalanceAmount = '5';

        await startRebalancerAndExpectLog(
          [
            `Manual rebalance strategy selected. Origin: ${CHAIN_NAME_2}, Destination: ${CHAIN_NAME_3}, Amount: ${manualRebalanceAmount}`,
            'Rebalance initiated',
            'Preparing all rebalance transactions.',
            `✅ Manual rebalance from ${CHAIN_NAME_2} to ${CHAIN_NAME_3} for amount ${manualRebalanceAmount} submitted successfully.`,
          ],
          {
            timeout: 30000,
            manual: true,
            origin: CHAIN_NAME_2,
            destination: CHAIN_NAME_3,
            amount: manualRebalanceAmount,
          },
        );

        await startRebalancerAndExpectLog(
          ['Calculating rebalancing routes', 'Found rebalancing routes'],
          {
            timeout: 90000,
            monitorOnly: true,
          },
        );
      } finally {
        await relayer.kill('SIGINT');
      }
    });
  });
});
