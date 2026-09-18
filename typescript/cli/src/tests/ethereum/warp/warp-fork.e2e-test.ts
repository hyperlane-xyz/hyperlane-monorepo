import { expect } from 'chai';
import { type BigNumber, Wallet, ethers } from 'ethers';
import { type ProcessPromise } from 'zx';

import { type ERC20Test } from '@hyperlane-xyz/core';
import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  TokenType,
  TransactionConfigType,
  TransactionDataType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, assert, retryAsync } from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { hyperlaneForkRaw } from '../commands/fork.js';
import { deployToken } from '../commands/helpers.js';
import {
  hyperlaneWarpCheckRaw,
  hyperlaneWarpDeploy,
  hyperlaneWarpForkRaw,
} from '../commands/warp.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  E2E_TEST_CONFIGS_PATH,
  TEMP_PATH,
  getCombinedWarpRoutePath,
} from '../consts.js';

const LOCAL_HOST = 'http://127.0.0.1';

const HAPPY_FORK_PORT = 8545;
const HAPPY_REGISTRY_PORT = HAPPY_FORK_PORT - 10;

const REPLAY_FORK_PORT = 8547;
const REPLAY_REGISTRY_PORT = REPLAY_FORK_PORT - 10;

const ARC_FORK_PORT = 8549;
const ARC_REGISTRY_PORT = ARC_FORK_PORT - 10;
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const ARC_FORK_REGISTRY_PATH = `${E2E_TEST_CONFIGS_PATH}/fork`;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
];

function getRpcHttpFromMetadata(meta: unknown): string {
  assert(
    typeof meta === 'object' && meta !== null && 'rpcUrls' in meta,
    'forked chain metadata missing rpcUrls',
  );
  const { rpcUrls } = meta;
  assert(
    Array.isArray(rpcUrls) && rpcUrls.length > 0,
    'forked chain metadata has empty rpcUrls',
  );
  const first: unknown = rpcUrls[0];
  assert(
    typeof first === 'object' &&
      first !== null &&
      'http' in first &&
      typeof first.http === 'string',
    'forked chain rpcUrls[0].http missing',
  );
  return first.http;
}

async function waitForForkedRegistry(
  registryPort: number,
  chainName: string,
  attempts = 30,
): Promise<string> {
  const res = await retryAsync(
    async () => {
      const response = await fetch(
        `${LOCAL_HOST}:${registryPort}/chain/${chainName}/metadata`,
      );
      assert(response.ok, 'forked registry server not ready');
      return response;
    },
    attempts,
    1000,
  );

  return getRpcHttpFromMetadata(await res.json());
}

describe('hyperlane warp fork e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses = {};
  let chain3Addresses: ChainAddresses = {};
  let token: ERC20Test;
  let tokenSymbol: string;
  let warpRouteId: string;
  let ownerAddress: Address;
  let forkProcess: ProcessPromise | undefined;

  before(async function () {
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    tokenSymbol = await token.symbol();
    ownerAddress = new Wallet(ANVIL_KEY).address;
    warpRouteId = createWarpRouteConfigId(tokenSymbol, CHAIN_NAME_3);
  });

  afterEach(async () => {
    const process = forkProcess;
    forkProcess = undefined;
    if (!process) return;

    try {
      if (process.output === null) await process.kill('SIGINT');
    } catch (error) {
      if (process.output === null) throw error;
    }
    await process;
  });

  // The global e2e beforeEach hook (e2e-test.setup.ts) wipes
  // deployments/warp_routes before every test, so the warp route must be
  // deployed inside each test, not in before().
  async function deployWarpRoute(): Promise<void> {
    const warpConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.collateral,
        token: token.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };

    const registryDeployPath = getCombinedWarpRoutePath(tokenSymbol, [
      CHAIN_NAME_3,
    ]).replace('-config.yaml', '-deploy.yaml');
    writeYamlOrJson(registryDeployPath, warpConfig);

    await hyperlaneWarpDeploy(warpRouteId);
  }

  it('serves a forked registry that passes warp check with no violations', async function () {
    await deployWarpRoute();

    forkProcess = hyperlaneWarpForkRaw({
      warpRouteId,
      port: HAPPY_FORK_PORT,
    }).nothrow();

    await waitForForkedRegistry(HAPPY_REGISTRY_PORT, CHAIN_NAME_2);

    const output = await hyperlaneWarpCheckRaw({
      warpRouteId,
      registry: `${LOCAL_HOST}:${HAPPY_REGISTRY_PORT}`,
    })
      .stdio('pipe')
      .nothrow();

    expect(output.exitCode).to.equal(0);
    expect(output.text()).to.include('No violations found');
  });

  it('replays an impersonated collateral transfer against the fork', async function () {
    await deployWarpRoute();

    const recipient = Wallet.createRandom().address;
    const amount = ethers.utils.parseEther('1');

    const transferCalldata = new ethers.utils.Interface(
      ERC20_ABI,
    ).encodeFunctionData('transfer', [recipient, amount]);

    const forkConfig = {
      [CHAIN_NAME_2]: {
        impersonateAccounts: [ANVIL_DEPLOYER_ADDRESS],
        transactions: [
          {
            type: TransactionConfigType.RAW_TRANSACTION,
            transactions: [
              {
                annotation: 'impersonated collateral transfer',
                from: ANVIL_DEPLOYER_ADDRESS,
                to: token.address,
                data: {
                  type: TransactionDataType.RAW_CALLDATA,
                  calldata: transferCalldata,
                },
                eventAssertions: [],
              },
            ],
          },
        ],
      },
    };

    const forkConfigPath = `${TEMP_PATH}/warp-fork-replay-config.yaml`;
    writeYamlOrJson(forkConfigPath, forkConfig);

    const beforeDeployer: BigNumber = await token.balanceOf(
      ANVIL_DEPLOYER_ADDRESS,
    );
    const beforeRecipient: BigNumber = await token.balanceOf(recipient);
    expect(beforeRecipient.isZero()).to.be.true;

    forkProcess = hyperlaneWarpForkRaw({
      warpRouteId,
      port: REPLAY_FORK_PORT,
      forkConfigPath,
    }).nothrow();

    const forkRpcUrl = await waitForForkedRegistry(
      REPLAY_REGISTRY_PORT,
      CHAIN_NAME_2,
    );

    const forkProvider = new ethers.providers.JsonRpcProvider(forkRpcUrl);
    const forkedToken = new ethers.Contract(
      token.address,
      ERC20_ABI,
      forkProvider,
    );

    const afterDeployer: BigNumber = await forkedToken.balanceOf(
      ANVIL_DEPLOYER_ADDRESS,
    );
    const afterRecipient: BigNumber = await forkedToken.balanceOf(recipient);

    expect(afterDeployer.toString()).to.equal(
      beforeDeployer.sub(amount).toString(),
    );
    expect(afterRecipient.toString()).to.equal(
      beforeRecipient.add(amount).toString(),
    );
  });

  it('replays native-USDC transfer and transferFrom on an Arc fork', async function () {
    const transferRecipient = Wallet.createRandom().address;
    const transferFromRecipient = Wallet.createRandom().address;
    const sender = ANVIL_DEPLOYER_ADDRESS;
    const spender = Wallet.createRandom().address;
    const amount = ethers.utils.parseUnits('1', 6);
    const forkConfigPath = `${TEMP_PATH}/warp-fork-arc-replay-config.yaml`;

    const usdcInterface = new ethers.utils.Interface(ERC20_ABI);
    const transferCalldata = usdcInterface.encodeFunctionData('transfer', [
      transferRecipient,
      amount,
    ]);
    const approveCalldata = usdcInterface.encodeFunctionData('approve', [
      spender,
      amount,
    ]);
    const transferFromCalldata = usdcInterface.encodeFunctionData(
      'transferFrom',
      [sender, transferFromRecipient, amount],
    );
    writeYamlOrJson(forkConfigPath, {
      arc: {
        impersonateAccounts: [sender, spender],
        transactions: [
          {
            type: TransactionConfigType.RAW_TRANSACTION,
            transactions: [
              {
                annotation: 'Arc native-USDC transfer',
                from: sender,
                to: ARC_USDC,
                data: {
                  type: TransactionDataType.RAW_CALLDATA,
                  calldata: transferCalldata,
                },
              },
              {
                annotation: 'Approve Arc native-USDC spender',
                from: sender,
                to: ARC_USDC,
                data: {
                  type: TransactionDataType.RAW_CALLDATA,
                  calldata: approveCalldata,
                },
              },
              {
                annotation: 'Arc native-USDC transferFrom',
                from: spender,
                to: ARC_USDC,
                data: {
                  type: TransactionDataType.RAW_CALLDATA,
                  calldata: transferFromCalldata,
                },
              },
            ],
          },
        ],
      },
    });

    forkProcess = hyperlaneForkRaw({
      registry: ARC_FORK_REGISTRY_PATH,
      forkConfigPath,
      port: ARC_FORK_PORT,
    }).nothrow();

    const forkRpcUrl = await waitForForkedRegistry(
      ARC_REGISTRY_PORT,
      'arc',
      60,
    );
    const forkProvider = new ethers.providers.JsonRpcProvider(forkRpcUrl);
    expect((await forkProvider.getNetwork()).chainId).to.equal(5042);
    expect((await forkProvider.send('anvil_nodeInfo', [])).network).to.equal(
      'arc',
    );

    const forkedUsdc = new ethers.Contract(ARC_USDC, ERC20_ABI, forkProvider);
    for (const recipient of [transferRecipient, transferFromRecipient]) {
      expect((await forkedUsdc.balanceOf(recipient)).toString()).to.equal(
        amount.toString(),
      );
    }
  });
});
