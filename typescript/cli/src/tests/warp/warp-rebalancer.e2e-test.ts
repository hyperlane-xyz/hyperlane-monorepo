import { Wallet, ethers } from 'ethers';
import { rmSync } from 'fs';
import { $ } from 'zx';

import { HypERC20Collateral__factory } from '@hyperlane-xyz/core';
import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  TokenType,
  WarpCoreConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, sleep, toWei } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../utils/files.js';
import {
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

describe('hyperlane warp rebalancer e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const CHECK_FREQUENCY = 1000;

  let tokenSymbol: string;
  let warpRouteId: string;
  let snapshots: { rpcUrl: string; snapshotId: string }[] = [];
  let ogVerbose: boolean;

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

    const warpDeploymentPath = getCombinedWarpRoutePath(tokenSymbol, [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      CHAIN_NAME_4,
    ]);
    const ownerAddress = new Wallet(ANVIL_KEY).address;
    const warpRouteDeployConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: tokenChain2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.collateral,
        token: tokenChain3.address,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_4]: {
        type: TokenType.synthetic,
        mailbox: chain4Addresses.mailbox,
        owner: ownerAddress,
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
        toWei(100),
      ),
      sleep(1000).then(() =>
        hyperlaneWarpSendRelay(
          CHAIN_NAME_3,
          CHAIN_NAME_4,
          warpDeploymentPath,
          true,
          toWei(100),
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

  async function startRebalancerAndExpectLog(
    log: string,
    timeout = 10000,
    withMetrics = false,
  ) {
    const process = hyperlaneWarpRebalancer(
      warpRouteId,
      CHECK_FREQUENCY,
      REBALANCER_CONFIG_PATH,
      withMetrics,
    );

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
      'Signer 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 is not a rebalancer',
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
      'Destination 0x4A679253410272dd5232B3Ff7cF5dbB88f295319 for domain 31338 is not allowed',
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
      'Bridge 0x0000000000000000000000000000000000000000 for domain 31338 is not allowed',
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

    await startRebalancerAndExpectLog(
      'cannot estimate gas; transaction may fail or may require manual gas limit',
    );
  });
});
