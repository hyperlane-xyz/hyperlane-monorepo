import { Wallet } from 'ethers';
import { rmSync } from 'fs';
import { $ } from 'zx';

import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import {
  ChainMetadata,
  TokenType,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { sleep, toWei } from '@hyperlane-xyz/utils';

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
  REBALANCER_STRATEGY_CONFIG_PATH,
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

  let warpDeploymentPath: string;
  let tokenSymbol: string;
  let warpRouteId: string;
  let snapshots: { rpcUrl: string; snapshotId: string }[] = [];

  before(async () => {
    const ogVerbose = $.verbose;
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
    const ownerAddress = new Wallet(ANVIL_KEY).address;
    const warpConfig: WarpRouteDeployConfig = {
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
    writeYamlOrJson(warpDeploymentPath, warpConfig);
    await hyperlaneWarpDeploy(warpDeploymentPath);

    warpRouteId = createWarpRouteConfigId(tokenSymbol.toUpperCase(), [
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      CHAIN_NAME_4,
    ]);

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

    $.verbose = ogVerbose;
  });

  beforeEach(async () => {
    writeYamlOrJson(REBALANCER_STRATEGY_CONFIG_PATH, {
      [CHAIN_NAME_2]: { weight: '100', tolerance: '0' },
      [CHAIN_NAME_3]: { weight: '100', tolerance: '0' },
    });

    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);
    const chain4Metadata: ChainMetadata = readYamlOrJson(CHAIN_4_METADATA_PATH);

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
    try {
      rmSync(REBALANCER_STRATEGY_CONFIG_PATH);
    } catch (e) {
      // Ignore
    }

    await Promise.all(
      snapshots.map(({ rpcUrl, snapshotId }) =>
        restoreSnapshot(rpcUrl, snapshotId),
      ),
    );
  });

  async function startRebalancerAndExpectLog(log: string): Promise<void> {
    const process = hyperlaneWarpRebalancer(
      warpRouteId,
      CHECK_FREQUENCY,
      REBALANCER_STRATEGY_CONFIG_PATH,
    );

    return new Promise(async (resolve, reject) => {
      process.catch((e) => {
        // TODO: Do a pretty print of the error
        reject(e.text());
      });

      for await (const chunk of process.stdout) {
        if (chunk.includes(log)) {
          resolve();
          await process.kill();
          break;
        }
      }
    });
  }

  it('should successfuly start the rebalancer', async () => {
    await startRebalancerAndExpectLog('Rebalancer started successfully 🚀');
  });

  it('should throw when strategy config file does not exist', async () => {
    rmSync(REBALANCER_STRATEGY_CONFIG_PATH);

    await startRebalancerAndExpectLog(
      `File doesn't exist at ${REBALANCER_STRATEGY_CONFIG_PATH}`,
    );
  });

  it('should throw if a strategy bigint cannot be parsed', async () => {
    writeYamlOrJson(REBALANCER_STRATEGY_CONFIG_PATH, {
      [CHAIN_NAME_2]: { weight: 'weight', tolerance: 0 },
      [CHAIN_NAME_3]: { weight: 100, tolerance: 0 },
    });

    await startRebalancerAndExpectLog(`Cannot convert weight to a BigInt`);

    writeYamlOrJson(REBALANCER_STRATEGY_CONFIG_PATH, {
      [CHAIN_NAME_2]: { weight: 100, tolerance: 0 },
      [CHAIN_NAME_3]: { weight: 100, tolerance: 'tolerance' },
    });

    await startRebalancerAndExpectLog(`Cannot convert tolerance to a BigInt`);
  });

  it('should log that no routes are to be executed', async () => {
    await startRebalancerAndExpectLog(`Executing rebalancing routes: []`);
  });

  it('should log that a single route is to be executed', async () => {
    writeYamlOrJson(REBALANCER_STRATEGY_CONFIG_PATH, {
      [CHAIN_NAME_2]: { weight: '75', tolerance: '0' },
      [CHAIN_NAME_3]: { weight: '25', tolerance: '0' },
    });

    await startRebalancerAndExpectLog(`Executing rebalancing routes: [
  {
    fromChain: 'anvil3',
    toChain: 'anvil2',
    amount: 50000000000000000000n
  }
]`);
  });
});
