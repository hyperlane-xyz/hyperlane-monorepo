import { Wallet } from 'ethers';
import { ProcessPromise } from 'zx';
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

  let process: ProcessPromise | undefined;

  let snapshots: { rpcUrl: string; snapshotId: string }[] = [];

  before(async () => {
    const ogVerbose = $.verbose;
    $.verbose = false;

    // Deploy core contracts on all chains
    const [chain2Addresses, chain3Addresses, chain4Addresses] =
      await Promise.all([
        deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
        deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
        deployOrUseExistingCore(CHAIN_NAME_4, CORE_CONFIG_PATH, ANVIL_KEY),
      ]);

    // Deploy ERC20s
    const [tokenChain2, tokenChain3] = await Promise.all([
      deployToken(ANVIL_KEY, CHAIN_NAME_2),
      deployToken(ANVIL_KEY, CHAIN_NAME_3),
    ]);
    tokenSymbol = await tokenChain2.symbol();

    // Deploy Warp Route
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

    $.verbose = ogVerbose;
  });

  beforeEach(async () => {
    process = undefined;

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
    if (process) {
      await process.kill();
    }

    await Promise.all(
      snapshots.map(({ rpcUrl, snapshotId }) =>
        restoreSnapshot(rpcUrl, snapshotId),
      ),
    );
  });

  it('should successfuly start the rebalancer', async () => {
    process = hyperlaneWarpRebalancer(warpRouteId, CHECK_FREQUENCY);

    for await (const chunk of process.stdout) {
      if (chunk.includes('Rebalancer started successfully 🚀')) {
        break;
      }
    }
  });

  describe('with no balance on collateral contracts', () => {
    it('should report an empty array of routes being executed', async () => {
      process = hyperlaneWarpRebalancer(warpRouteId, CHECK_FREQUENCY);

      for await (const chunk of process.stdout) {
        if (chunk.includes('Executing rebalancing routes: []')) {
          break;
        }
      }
    });
  });

  describe('with the same balance on all collateral contracts', () => {
    beforeEach(async () => {
      const ogVerbose = $.verbose;
      $.verbose = false;

      await Promise.all([
        hyperlaneWarpSendRelay(
          CHAIN_NAME_2,
          CHAIN_NAME_4,
          warpDeploymentPath,
          true,
          toWei(50),
        ),
        sleep(1000).then(() =>
          hyperlaneWarpSendRelay(
            CHAIN_NAME_3,
            CHAIN_NAME_4,
            warpDeploymentPath,
            true,
            toWei(50),
          ),
        ),
      ]);

      $.verbose = ogVerbose;
    });

    it('should report an empty array of routes being executed', async () => {
      process = hyperlaneWarpRebalancer(warpRouteId, CHECK_FREQUENCY);

      for await (const chunk of process.stdout) {
        if (chunk.includes('Executing rebalancing routes: []')) {
          break;
        }
      }
    });
  });

  describe('with different balances on collateral contracts', () => {
    beforeEach(async () => {
      const ogVerbose = $.verbose;
      $.verbose = false;

      await Promise.all([
        hyperlaneWarpSendRelay(
          CHAIN_NAME_2,
          CHAIN_NAME_4,
          warpDeploymentPath,
          true,
          toWei(40),
        ),
        sleep(1000).then(() =>
          hyperlaneWarpSendRelay(
            CHAIN_NAME_3,
            CHAIN_NAME_4,
            warpDeploymentPath,
            true,
            toWei(60),
          ),
        ),
      ]);

      $.verbose = ogVerbose;
    });

    it('should report an array of routes being executed', async () => {
      process = hyperlaneWarpRebalancer(warpRouteId, CHECK_FREQUENCY);

      for await (const chunk of process.stdout) {
        if (
          chunk.includes(
            `Executing rebalancing routes: [
  {
    fromChain: 'anvil3',
    toChain: 'anvil2',
    amount: 10000000000000000000n
  }
]`,
          )
        ) {
          break;
        }
      }
    });

    describe('with strategy tolerance of 10 ether', () => {
      it('should report an empty array of routes being executed', async () => {
        process = hyperlaneWarpRebalancer(warpRouteId, CHECK_FREQUENCY, {
          strategyTolerance: BigInt(toWei(10)),
        });

        for await (const chunk of process.stdout) {
          if (chunk.includes('Executing rebalancing routes: []')) {
            break;
          }
        }
      });
    });
  });
});
