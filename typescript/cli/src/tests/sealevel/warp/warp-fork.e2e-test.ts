import { expect } from 'chai';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import { SealevelSigner, createRpc } from '@hyperlane-xyz/sealevel-sdk';
import { airdropSol, createSplMint } from '@hyperlane-xyz/sealevel-sdk/testing';
import {
  TokenFeeType,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, pollAsync } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { syncWarpDeployConfigToRegistry } from '../../commands/warp-config-sync.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_ADDRESSES_PATH_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
} from '../../constants.js';

const CHAIN_NAME = 'svmlocal1';
const REMOTE_CHAIN_NAME = 'anvil1';
const SVM_KEY = HYP_KEY_BY_PROTOCOL.sealevel;
const LOCAL_HOST = 'http://127.0.0.1';
const FORK_TIMEOUT = 600_000;

const HAPPY_FORK_PORT = 8600;
const HAPPY_REGISTRY_PORT = HAPPY_FORK_PORT - 10;

const REPLAY_FORK_PORT = 8602;
const REPLAY_REGISTRY_PORT = REPLAY_FORK_PORT - 10;

const SPECIFIC_REMOTE_ROUTER =
  '0x000000000000000000000000000000000000000000000000000000000000beef';

async function waitForForkedRegistry(
  registryPort: number,
  chainName: string,
): Promise<void> {
  await pollAsync(
    async () => {
      const response = await fetch(
        `${LOCAL_HOST}:${registryPort}/chain/${chainName}/metadata`,
      );
      assert(response.ok, 'forked registry server not ready');
    },
    1000,
    30,
  );
}

// The upstream was just written at confirmed commitment; surfpool copy-on-read
// fetches the datasource at finalized commitment, so wait for finalization
// before forking or the fork sees pre-deploy state.
async function waitForFinalizedSlot(
  rpc: ReturnType<typeof createRpc>,
): Promise<void> {
  const target = await rpc.getSlot({ commitment: 'confirmed' }).send();
  await pollAsync(
    async () => {
      const finalized = await rpc.getSlot({ commitment: 'finalized' }).send();
      assert(finalized >= target, `finalized ${finalized} below ${target}`);
    },
    1000,
    90,
  );
}

describe('hyperlane warp fork CLI e2e tests (Sealevel)', function () {
  this.timeout(FORK_TIMEOUT);

  let rpc: ReturnType<typeof createRpc>;
  let signer: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;
  let mailboxAddress: string;

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/svm-fork-read.yaml`,
  );

  before(async function () {
    rpc = createRpc(
      TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl,
    );
    signer = await SealevelSigner.connectWithSigner(
      TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      SVM_KEY,
    );

    await airdropSol(rpc, signer.getSignerAddress(), 50_000_000_000n);

    const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
      ProtocolType.Sealevel,
      CHAIN_NAME,
      REGISTRY_PATH,
      CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );
    const coreConfig = readYamlOrJson(CORE_CONFIG_PATH_BY_PROTOCOL.sealevel);
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      coreConfig,
    );
    hyperlaneCore.setCoreInputPath(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );
    await hyperlaneCore.deploy(SVM_KEY);

    const coreAddresses: ChainAddresses = readYamlOrJson(
      CORE_ADDRESSES_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );
    mailboxAddress = coreAddresses.mailbox;
  });

  it('serves a forked registry that passes warp check with no violations', async function () {
    const ownerAddress = signer.getSignerAddress();
    const mint = await createSplMint(rpc, signer, 9);
    const symbol = 'FORKT';
    const warpRouteId = createWarpRouteConfigId(symbol, CHAIN_NAME);

    const config: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.crossCollateral,
        token: String(mint),
        name: 'Fork Test Token',
        symbol,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
        remoteRouters: {
          [REMOTE_CHAIN_NAME]: { address: SPECIFIC_REMOTE_ROUTER },
        },
      },
    };
    const deployPath = `${TEMP_PATH}/svm-fork-deploy.yaml`;
    writeYamlOrJson(deployPath, config);

    await warpCommands.deploy(SVM_KEY, warpRouteId, deployPath);

    // Sync the registry deploy config to the actual deployed on-chain state so
    // the un-mutated fork produces zero violations (the deploy sets defaults,
    // e.g. destinationGas, that the input config omits).
    const warpCorePath = getWarpCoreConfigPath(symbol, [CHAIN_NAME]);
    const onChainConfig = await warpCommands.readConfig(
      CHAIN_NAME,
      warpCorePath,
    );
    writeYamlOrJson(
      getWarpDeployConfigPath(symbol, [CHAIN_NAME]),
      onChainConfig,
    );

    await waitForFinalizedSlot(rpc);

    const forkProcess = warpCommands
      .fork({ warpRouteId, port: HAPPY_FORK_PORT })
      .nothrow();

    try {
      await waitForForkedRegistry(HAPPY_REGISTRY_PORT, CHAIN_NAME);

      const output = await warpCommands
        .checkRaw({
          warpRouteId,
          registry: `${LOCAL_HOST}:${HAPPY_REGISTRY_PORT}`,
        })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    } finally {
      try {
        await forkProcess.kill('SIGINT');
        await forkProcess;
      } catch {
        // Process may have already exited, which is fine
      }
    }
  });

  it('replays a governance fee change against the fork and passes warp check', async function () {
    const ownerAddress = signer.getSignerAddress();
    const symbol = 'FORKRPL';
    const warpRouteId = createWarpRouteConfigId(symbol, CHAIN_NAME);

    const baseConfig: WarpRouteDeployConfig[string] = {
      type: TokenType.native,
      name: 'Fork Replay Token',
      symbol,
      decimals: 9,
      mailbox: mailboxAddress,
      owner: ownerAddress,
    };
    const deployConfig: WarpRouteDeployConfig = { [CHAIN_NAME]: baseConfig };
    const deployPath = `${TEMP_PATH}/svm-fork-replay-deploy.yaml`;
    writeYamlOrJson(deployPath, deployConfig);
    await warpCommands.deploy(SVM_KEY, warpRouteId, deployPath);

    // Desired state B = deployed native config + a new LinearFee (native sets no
    // extra on-chain defaults, so B matches the fork once the fee is replayed).
    const desiredConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        ...baseConfig,
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ownerAddress,
          bps: 75,
        },
      },
    };
    writeYamlOrJson(deployPath, desiredConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: deployPath,
      warpRouteId,
      registryPath: REGISTRY_PATH,
    });

    // Emit the governance transactions to a file instead of submitting them.
    const txFile = `${TEMP_PATH}/svm-fork-replay-txs.yaml`;
    const strategyPath = `${TEMP_PATH}/svm-fork-file-strategy.yaml`;
    writeYamlOrJson(strategyPath, {
      [CHAIN_NAME]: {
        submitter: {
          type: 'file',
          filepath: txFile,
          chain: CHAIN_NAME,
        },
      },
    });
    await warpCommands.applyRaw({
      warpRouteId,
      strategyUrl: strategyPath,
      privateKey: SVM_KEY,
      skipConfirmationPrompts: true,
    });

    const forkConfigPath = `${TEMP_PATH}/svm-fork-replay-config.yaml`;
    writeYamlOrJson(forkConfigPath, { [CHAIN_NAME]: { path: txFile } });

    await waitForFinalizedSlot(rpc);

    const forkProcess = warpCommands
      .fork({ warpRouteId, port: REPLAY_FORK_PORT, forkConfigPath })
      .nothrow();

    try {
      await waitForForkedRegistry(REPLAY_REGISTRY_PORT, CHAIN_NAME);

      const output = await warpCommands
        .checkRaw({
          warpRouteId,
          registry: `${LOCAL_HOST}:${REPLAY_REGISTRY_PORT}`,
        })
        .stdio('pipe')
        .nothrow();

      expect(output.exitCode).to.equal(0);
      expect(output.text()).to.include('No violations found');
    } finally {
      try {
        await forkProcess.kill('SIGINT');
        await forkProcess;
      } catch {
        // Process may have already exited, which is fine
      }
    }
  });
});
