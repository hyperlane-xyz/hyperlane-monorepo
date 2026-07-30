import { expect } from 'chai';
import { Wallet, providers } from 'ethers';

import {
  type DelayedFlowRouterHookIsm,
  DelayedFlowRouterHookIsm__factory,
  MailboxClient__factory,
} from '@hyperlane-xyz/core';
import { createWarpRouteConfigId } from '@hyperlane-xyz/registry';
import {
  IsmType,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address, addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { hyperlaneCoreDeploy } from '../commands/core.js';
import { hyperlaneRelayer, hyperlaneSendMessage } from '../commands/helpers.js';
import {
  hyperlaneWarpCheck,
  hyperlaneWarpDeploy,
  hyperlaneWarpSendRelay,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../consts.js';

const SYMBOL = 'DFR';
const WARP_ID = createWarpRouteConfigId(SYMBOL, CHAIN_NAME_3);
const WARP_CORE_CONFIG_PATH = `${REGISTRY_PATH}/deployments/warp_routes/${WARP_ID}-config.yaml`;

const ANVIL2_RPC = 'http://127.0.0.1:8555';
const ANVIL3_RPC = 'http://127.0.0.1:8600';

// Small cap on any single message's delay: the first inbound transfer to the
// synthetic leg necessarily hits the empty-bucket clamp (TVL = totalSupply = 0
// before the first mint), so it waits exactly this many seconds while the
// relayer retries `MessageNotReadyUntil` reverts.
const MAX_DELAY_SECONDS = 5;

describe('hyperlane warp deploy with DelayedFlowRouterHookIsm e2e tests', async function () {
  this.timeout(3 * DEFAULT_E2E_TEST_TIMEOUT);

  const deployerAddress = new Wallet(ANVIL_KEY).address;

  // The DelayedFlowRouterHookIsm authenticates flow only (moduleType NULL);
  // its docstring mandates composing it under an authenticating ISM, so the
  // production shape is an aggregation with threshold 2.
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
    rpcUrl: string,
    tokenAddress: Address,
  ): Promise<DelayedFlowRouterHookIsm> {
    const provider = new providers.JsonRpcProvider(rpcUrl);
    // deploy wires the hybrid instance as the token's hook
    const hookAddress = await MailboxClient__factory.connect(
      tokenAddress,
      provider,
    ).hook();
    return DelayedFlowRouterHookIsm__factory.connect(hookAddress, provider);
  }

  before(async () => {
    await Promise.all([
      hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH),
      hyperlaneCoreDeploy(CHAIN_NAME_3, CORE_CONFIG_PATH),
    ]);

    // Bump both mailboxes past nonce 0: DelayedFlowRouterHookIsm's credit
    // replay guard (`nonce <= lastCreditedNonce`, initialized to 0) can never
    // credit a mailbox-nonce-0 message, so the first-ever dispatch on a fresh
    // chain would revert AlreadyCredited(0) inside postDispatch.
    await hyperlaneSendMessage(CHAIN_NAME_2, CHAIN_NAME_3, { quick: true });
    await hyperlaneSendMessage(CHAIN_NAME_3, CHAIN_NAME_2, { quick: true });
  });

  it('deploys, converges on warp check, and delivers transfers in both directions', async () => {
    const warpConfig: WarpRouteDeployConfig = {
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
    const warpConfigPath = `${TEMP_PATH}/warp-route-delayed-flow-config.yaml`;
    writeYamlOrJson(warpConfigPath, warpConfig);

    await hyperlaneWarpDeploy(warpConfigPath, WARP_ID);

    // the deployed route must converge: no diffs against the same config
    const checkOutput = await hyperlaneWarpCheck(WARP_ID).nothrow();
    expect(checkOutput.exitCode).to.equal(0);
    expect(checkOutput.text()).to.include('No violations found');

    // resolve the deployed tokens and their DelayedFlowRouterHookIsm instances
    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      WARP_CORE_CONFIG_PATH,
    );
    const tokenByChain = Object.fromEntries(
      warpCoreConfig.tokens.map((token) => {
        assert(
          token.addressOrDenom,
          `Missing address for ${token.chainName} token`,
        );
        return [token.chainName, token.addressOrDenom];
      }),
    );
    const dfrAnvil2 = await connectDelayedFlowIsm(
      ANVIL2_RPC,
      tokenByChain[CHAIN_NAME_2],
    );
    const dfrAnvil3 = await connectDelayedFlowIsm(
      ANVIL3_RPC,
      tokenByChain[CHAIN_NAME_3],
    );

    // both instances are paired with their router and mutually enrolled
    expect((await dfrAnvil2.warpRouter()).toLowerCase()).to.equal(
      tokenByChain[CHAIN_NAME_2].toLowerCase(),
    );
    expect((await dfrAnvil3.warpRouter()).toLowerCase()).to.equal(
      tokenByChain[CHAIN_NAME_3].toLowerCase(),
    );
    const anvil2Domain = 31338;
    const anvil3Domain = 31347;
    expect(await dfrAnvil2.routers(anvil3Domain)).to.equal(
      addressToBytes32(dfrAnvil3.address).toLowerCase(),
    );
    expect(await dfrAnvil3.routers(anvil2Domain)).to.equal(
      addressToBytes32(dfrAnvil2.address).toLowerCase(),
    );

    // the relayer must run WITHOUT the warp-route whitelist: the preverify
    // messages are DFR->DFR, not token->token, and would be filtered out
    const relayer = hyperlaneRelayer([CHAIN_NAME_2, CHAIN_NAME_3]);
    try {
      await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_2,
        destination: CHAIN_NAME_3,
        warpRouteId: WARP_ID,
        relay: false,
      });

      // the DFR engaged: the destination instance preverified the transfer
      // (readyAt committed via MessageQueued) before the mailbox delivered it
      const queuedOnAnvil3 = await dfrAnvil3.queryFilter(
        dfrAnvil3.filters.MessageQueued(),
      );
      expect(queuedOnAnvil3.length).to.be.at.least(1);
      const queued = queuedOnAnvil3[queuedOnAnvil3.length - 1];
      expect(queued.args.readyAt).to.be.greaterThan(0);
      expect(
        (await dfrAnvil3.readyAt(queued.args.messageId)).toString(),
      ).to.equal(queued.args.readyAt.toString());
      // the origin instance credited its bucket on dispatch
      expect(await dfrAnvil2.lastCreditedNonce()).to.be.greaterThan(0);

      await hyperlaneWarpSendRelay({
        origin: CHAIN_NAME_3,
        destination: CHAIN_NAME_2,
        warpRouteId: WARP_ID,
        relay: false,
      });

      const queuedOnAnvil2 = await dfrAnvil2.queryFilter(
        dfrAnvil2.filters.MessageQueued(),
      );
      expect(queuedOnAnvil2.length).to.be.at.least(1);
      expect(await dfrAnvil3.lastCreditedNonce()).to.be.greaterThan(0);
    } finally {
      try {
        await relayer.kill('SIGINT');
      } catch {
        // Process may have already exited, which is fine
      }
    }
  });
});
