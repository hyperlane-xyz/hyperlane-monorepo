import { expect } from 'chai';
import { Wallet, ethers, providers } from 'ethers';

import {
  type DelayedFlowRouterHookIsm,
  DelayedFlowRouterHookIsm__factory,
  MailboxClient__factory,
} from '@hyperlane-xyz/core';
import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import {
  type CallData,
  IsmType,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, addressToBytes32, assert } from '@hyperlane-xyz/utils';

import {
  CustomTxSubmitterType,
  type ExtendedChainSubmissionStrategy,
} from '../../../submitters/types.js';

import { syncWarpDeployConfigToRegistry } from '../../commands/warp-config-sync.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { hyperlaneRelayer, hyperlaneSendMessage } from '../commands/helpers.js';
import {
  hyperlaneWarpApply,
  hyperlaneWarpApplyRaw,
  hyperlaneWarpCheck,
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CHAIN_NAME_4,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../consts.js';

const SYMBOL = 'DFRAPPLY';
const WARP_ID = createWarpRouteConfigId(SYMBOL, CHAIN_NAME_3);
const WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/${WARP_ID}-config.yaml`;
const WARP_DEPLOY_PATH = `${TEMP_PATH}/warp-apply-delayed-flow-config.yaml`;
const FILE_STRATEGY_PATH = `${TEMP_PATH}/warp-apply-delayed-flow-strategy.yaml`;
const FILE_SUBMITTER_OUTPUT_PATH = `${TEMP_PATH}/warp-apply-delayed-flow-batch.json`;

const RPC_BY_CHAIN: Record<string, string> = {
  [CHAIN_NAME_2]: 'http://127.0.0.1:8555',
  [CHAIN_NAME_3]: 'http://127.0.0.1:8600',
  [CHAIN_NAME_4]: 'http://127.0.0.1:8601',
};
const DOMAIN_BY_CHAIN: Record<string, number> = {
  [CHAIN_NAME_2]: 31338,
  [CHAIN_NAME_3]: 31347,
  [CHAIN_NAME_4]: 31348,
};

// See warp-delayed-flow.e2e-test.ts: the first inbound transfer to a synthetic
// leg hits the empty-bucket clamp, so keep the cap small enough that the
// relayer's retry loop rides it out quickly.
const MAX_DELAY_SECONDS = 5;

describe('hyperlane warp apply with DelayedFlowRouterHookIsm e2e tests', async function () {
  this.timeout(5 * DEFAULT_E2E_TEST_TIMEOUT);

  const deployerAddress = new Wallet(ANVIL_KEY).address;

  // The DFR authenticates flow only (moduleType NULL), so its docstring
  // mandates composing it under an authenticating ISM.
  function delayedFlowIsmConfig(): WarpRouteDeployConfig[string]['interchainSecurityModule'] {
    return {
      type: IsmType.AGGREGATION,
      threshold: 2,
      modules: [
        {
          type: IsmType.TRUSTED_RELAYER,
          relayer: deployerAddress,
        },
        {
          type: IsmType.DELAYED_FLOW_ROUTER,
          thresholdBps: 10000,
          maxDelay: MAX_DELAY_SECONDS,
          duration: 86400n,
          owner: deployerAddress,
        },
      ],
    };
  }

  async function connectDelayedFlowIsm(
    chain: string,
    tokenAddress: Address,
  ): Promise<DelayedFlowRouterHookIsm> {
    const provider = new providers.JsonRpcProvider(RPC_BY_CHAIN[chain]);
    const hookAddress = await MailboxClient__factory.connect(
      tokenAddress,
      provider,
    ).hook();
    return DelayedFlowRouterHookIsm__factory.connect(hookAddress, provider);
  }

  function readTokensByChain(): Record<string, Address> {
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH,
    );
    return Object.fromEntries(
      warpCoreConfig.tokens.map((token) => {
        assert(
          token.addressOrDenom,
          `Missing address for ${token.chainName} token`,
        );
        return [token.chainName, token.addressOrDenom];
      }),
    );
  }

  async function expectMutualEnrollment(chains: string[]) {
    const tokens = readTokensByChain();
    const dfrByChain: Record<string, DelayedFlowRouterHookIsm> = {};
    for (const chain of chains) {
      dfrByChain[chain] = await connectDelayedFlowIsm(chain, tokens[chain]);
      expect((await dfrByChain[chain].warpRouter()).toLowerCase()).to.equal(
        tokens[chain].toLowerCase(),
      );
    }

    for (const chain of chains) {
      for (const remote of chains) {
        if (chain === remote) continue;
        expect(
          await dfrByChain[chain].routers(DOMAIN_BY_CHAIN[remote]),
          `${chain} should enroll ${remote}`,
        ).to.equal(addressToBytes32(dfrByChain[remote].address).toLowerCase());
      }
    }
    return dfrByChain;
  }

  let chain4Addresses: ChainAddresses;

  before(async () => {
    const [, , anvil4Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_4, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);
    chain4Addresses = anvil4Addresses;

    // The DFR credit replay guard (`nonce <= lastCreditedNonce`, initialized
    // to 0) can never credit a mailbox-nonce-0 message, so bump every mailbox
    // past nonce 0 before any warp dispatch.
    await hyperlaneSendMessage(CHAIN_NAME_2, CHAIN_NAME_3, { quick: true });
    await hyperlaneSendMessage(CHAIN_NAME_3, CHAIN_NAME_2, { quick: true });
    await hyperlaneSendMessage(CHAIN_NAME_4, CHAIN_NAME_2, { quick: true });
  });

  // The shared e2e setup wipes deployments/warp_routes before EVERY test, so
  // the route has to be deployed inside the test that uses it.
  async function deployPlainRoute() {
    const plainConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        symbol: SYMBOL,
        owner: deployerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        symbol: SYMBOL,
        owner: deployerAddress,
      },
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, plainConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_PATH, WARP_ID);
  }

  it('adds a DelayedFlowRouterHookIsm to an existing route, then enrolls a newly extended chain', async () => {
    await deployPlainRoute();

    // Scenario A: edit the config to add the hybrid on both chains.
    const withDelayedFlow: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        symbol: SYMBOL,
        owner: deployerAddress,
        interchainSecurityModule: delayedFlowIsmConfig(),
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        symbol: SYMBOL,
        owner: deployerAddress,
        interchainSecurityModule: delayedFlowIsmConfig(),
      },
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, withDelayedFlow);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ID,
      registryPath: REGISTRY_PATH,
    });

    await hyperlaneWarpApply(WARP_ID);

    // Both instances exist, are paired with their router, and are mutually
    // enrolled — the enrollment the user should not have to configure.
    const dfrByChain = await expectMutualEnrollment([
      CHAIN_NAME_2,
      CHAIN_NAME_3,
    ]);

    // warp check must converge on the same config that was applied.
    const checkOutput = await hyperlaneWarpCheck(WARP_ID).nothrow();
    expect(checkOutput.exitCode).to.equal(0);
    expect(checkOutput.text()).to.include('No violations found');

    // A second apply is a no-op.
    const secondApply = await hyperlaneWarpApplyRaw({
      warpRouteId: WARP_ID,
    }).nothrow();
    expect(secondApply.exitCode).to.equal(0);
    expect(secondApply.text()).to.include(
      'Warp config is the same as target. No updates needed.',
    );

    // Delivery works through the newly wired hybrid.
    const relayer = hyperlaneRelayer([CHAIN_NAME_2, CHAIN_NAME_3]);
    try {
      await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_3,
        warpRouteId: WARP_ID,
        relay: false,
      });

      const queued = await dfrByChain[CHAIN_NAME_3].queryFilter(
        dfrByChain[CHAIN_NAME_3].filters.MessageQueued(),
      );
      expect(queued.length).to.be.at.least(1);
      expect(queued[queued.length - 1].args.readyAt).to.be.greaterThan(0);
      expect(
        await dfrByChain[CHAIN_NAME_2].lastCreditedNonce(),
      ).to.be.greaterThan(0);
    } finally {
      try {
        await relayer.kill('SIGINT');
      } catch {
        // Process may have already exited, which is fine
      }
    }

    // Scenario B: extend the DFR route to a third chain.
    const extendedConfig: WarpRouteDeployConfig =
      readYamlOrJson(WARP_DEPLOY_PATH);
    extendedConfig[CHAIN_NAME_4] = {
      type: TokenType.synthetic,
      // Token metadata is supplied explicitly for the new chain, as in the
      // other extension e2e tests.
      name: 'Ether',
      symbol: SYMBOL,
      decimals: 18,
      mailbox: chain4Addresses.mailbox,
      owner: deployerAddress,
      interchainSecurityModule: delayedFlowIsmConfig(),
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, extendedConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_PATH,
      warpRouteId: WARP_ID,
      registryPath: REGISTRY_PATH,
    });

    await hyperlaneWarpApply(WARP_ID);

    // The new chain enrolls both existing instances AND both existing
    // instances enroll the new one.
    const extendedDfrByChain = await expectMutualEnrollment([
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      CHAIN_NAME_4,
    ]);

    // The freshly deployed instance ends up under the configured owner.
    expect(
      (await extendedDfrByChain[CHAIN_NAME_4].owner()).toLowerCase(),
    ).to.equal(deployerAddress.toLowerCase());

    const extendedCheckOutput = await hyperlaneWarpCheck(WARP_ID).nothrow();
    expect(extendedCheckOutput.exitCode).to.equal(0);
    expect(extendedCheckOutput.text()).to.include('No violations found');

    // Delivery works on a leg involving the newly extended chain.
    const extendedRelayer = hyperlaneRelayer([
      CHAIN_NAME_2,
      CHAIN_NAME_3,
      CHAIN_NAME_4,
    ]);
    try {
      await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_4,
        warpRouteId: WARP_ID,
        relay: false,
      });

      const extendedQueued = await extendedDfrByChain[CHAIN_NAME_4].queryFilter(
        extendedDfrByChain[CHAIN_NAME_4].filters.MessageQueued(),
      );
      expect(extendedQueued.length).to.be.at.least(1);
      expect(
        extendedQueued[extendedQueued.length - 1].args.readyAt,
      ).to.be.greaterThan(0);
    } finally {
      try {
        await extendedRelayer.kill('SIGINT');
      } catch {
        // Process may have already exited, which is fine
      }
    }

    // Enrollment transactions must ride whichever submitter the strategy
    // configures for the chain rather than assuming a deployer-signed
    // JSON-RPC send — that is what makes a Safe/ICA-owned instance workable.
    // Introduce drift, then apply under a FILE submitter and assert the
    // enrollment lands in the written batch instead of on-chain.
    const anvil2Signer = new Wallet(ANVIL_KEY).connect(
      new providers.JsonRpcProvider(RPC_BY_CHAIN[CHAIN_NAME_2]),
    );
    const anvil2Dfr = DelayedFlowRouterHookIsm__factory.connect(
      extendedDfrByChain[CHAIN_NAME_2].address,
      anvil2Signer,
    );
    const unenrollTx = await anvil2Dfr.unenrollRemoteRouter(
      DOMAIN_BY_CHAIN[CHAIN_NAME_3],
    );
    await unenrollTx.wait();
    expect(await anvil2Dfr.routers(DOMAIN_BY_CHAIN[CHAIN_NAME_3])).to.equal(
      ethers.constants.HashZero,
    );

    const fileStrategy: ExtendedChainSubmissionStrategy = {
      [CHAIN_NAME_2]: {
        submitter: {
          type: CustomTxSubmitterType.FILE,
          chain: CHAIN_NAME_2,
          filepath: FILE_SUBMITTER_OUTPUT_PATH,
        },
      },
    };
    writeYamlOrJson(FILE_STRATEGY_PATH, fileStrategy);

    const strategyApply = await hyperlaneWarpApplyRaw({
      warpRouteId: WARP_ID,
      strategyUrl: FILE_STRATEGY_PATH,
    }).nothrow();
    expect(strategyApply.exitCode).to.equal(0);

    const batch: CallData[] = readYamlOrJson(FILE_SUBMITTER_OUTPUT_PATH);
    const enrollSelector =
      DelayedFlowRouterHookIsm__factory.createInterface().getSighash(
        'enrollRemoteRouters',
      );
    const enrollmentTx = batch.find(
      (tx) =>
        tx.to.toLowerCase() === anvil2Dfr.address.toLowerCase() &&
        tx.data.startsWith(enrollSelector),
    );
    assert(
      enrollmentTx,
      'Expected the DFR enrollment tx in the file submitter batch',
    );

    // The batch was written, not executed: the drift is still on-chain.
    expect(await anvil2Dfr.routers(DOMAIN_BY_CHAIN[CHAIN_NAME_3])).to.equal(
      ethers.constants.HashZero,
    );
  });
});
