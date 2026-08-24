import { expect } from 'chai';

import { HookType } from '../hook/types.js';
import { IsmConfig, IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress } from '../test/testUtils.js';
import { TokenType } from '../token/config.js';
import { WarpRouteDeployConfigMailboxRequired } from '../token/types.js';

import { planWarpRouteHybrids, resolveHybridTrees } from './warpHybridPlan.js';

describe('planWarpRouteHybrids', () => {
  const chain = 'test1';
  const owner = randomAddress();
  const multiProvider = MultiProvider.createTestMultiProvider();

  const hybrid = () => ({
    type: IsmType.DELAYED_FLOW_ROUTER,
    thresholdBps: 10000,
    maxDelay: 60,
    duration: 86400n,
    owner,
  });

  const netFlowHybrid = () => ({
    type: IsmType.NET_FLOW_RATE_LIMITED,
    thresholdBps: 5000,
    duration: 86400n,
    owner,
  });

  function config(
    hook: WarpRouteDeployConfigMailboxRequired[string]['hook'],
    ismHybrid: IsmConfig = hybrid(),
    feeHook?: string,
  ): WarpRouteDeployConfigMailboxRequired {
    return {
      [chain]: {
        type: TokenType.synthetic,
        name: 'Hybrid',
        symbol: 'HYB',
        decimals: 18,
        owner,
        mailbox: randomAddress(),
        interchainSecurityModule: {
          type: IsmType.AGGREGATION,
          threshold: 2,
          modules: [
            { type: IsmType.TRUSTED_RELAYER, relayer: owner },
            ismHybrid,
          ],
        },
        hook,
        feeHook,
      },
    };
  }

  it('pairs equal declarations and preserves both trees', () => {
    const plan = planWarpRouteHybrids({
      multiProvider,
      warpDeployConfig: config(hybrid()),
    });

    expect(plan[chain].node.type).to.equal(IsmType.DELAYED_FLOW_ROUTER);
    expect(plan[chain].hookTree).to.deep.equal(hybrid());
  });

  it('replaces a nested hybrid with one address in both trees', () => {
    const plan = planWarpRouteHybrids({
      multiProvider,
      warpDeployConfig: config({
        type: HookType.AGGREGATION,
        hooks: [hybrid(), { type: HookType.MERKLE_TREE }],
      }),
    });
    const address = randomAddress();
    const resolved = resolveHybridTrees(plan[chain], address);

    expect(resolved.hook).to.deep.equal({
      type: HookType.AGGREGATION,
      hooks: [address, { type: HookType.MERKLE_TREE }],
    });
    expect(resolved.ism).to.deep.equal({
      type: IsmType.AGGREGATION,
      threshold: 2,
      modules: [{ type: IsmType.TRUSTED_RELAYER, relayer: owner }, address],
    });
  });

  it('rejects an aggregated hybrid with an ERC20 fee hook', () => {
    expect(() =>
      planWarpRouteHybrids({
        multiProvider,
        warpDeployConfig: config(
          {
            type: HookType.AGGREGATION,
            hooks: [hybrid(), { type: HookType.MERKLE_TREE }],
          },
          hybrid(),
          randomAddress(),
        ),
      }),
    ).to.throw('cannot be combined with non-zero feeHook');
  });

  it('rejects a top-level delayed-flow hybrid with an ERC20 fee hook', () => {
    expect(() =>
      planWarpRouteHybrids({
        multiProvider,
        warpDeployConfig: config(hybrid(), hybrid(), randomAddress()),
      }),
    ).to.throw('cannot be combined with non-zero feeHook');
  });

  it('allows a delayed-flow hybrid when the fee hook is explicitly disabled', () => {
    const plan = planWarpRouteHybrids({
      multiProvider,
      warpDeployConfig: config(
        {
          type: HookType.AGGREGATION,
          hooks: [hybrid(), { type: HookType.MERKLE_TREE }],
        },
        hybrid(),
        '0x0000000000000000000000000000000000000000',
      ),
    });
    expect(plan[chain].node.type).to.equal(IsmType.DELAYED_FLOW_ROUTER);
  });

  it('allows an aggregated net-flow hybrid with an ERC20 fee hook', () => {
    const node = netFlowHybrid();
    const plan = planWarpRouteHybrids({
      multiProvider,
      warpDeployConfig: config(
        {
          type: HookType.AGGREGATION,
          hooks: [node, { type: HookType.MERKLE_TREE }],
        },
        node,
        randomAddress(),
      ),
    });

    expect(plan[chain].node.type).to.equal(IsmType.NET_FLOW_RATE_LIMITED);
  });

  it('rejects different declarations before deployment', () => {
    expect(() =>
      planWarpRouteHybrids({
        multiProvider,
        warpDeployConfig: config({ ...hybrid(), maxDelay: 61 }),
      }),
    ).to.throw('declared differently');
  });

  it('requires the hybrid and router to share one owner', () => {
    const separatelyOwned = { ...hybrid(), owner: randomAddress() };
    expect(() =>
      planWarpRouteHybrids({
        multiProvider,
        warpDeployConfig: config(separatelyOwned, separatelyOwned),
      }),
    ).to.throw("must share the router's owner");
  });

  it('requires the hybrid on both config surfaces', () => {
    expect(() =>
      planWarpRouteHybrids({
        multiProvider,
        warpDeployConfig: config(undefined),
      }),
    ).to.throw("not in the 'hook' tree");
  });

  it('rejects a hybrid below a conditional routing hook', () => {
    expect(() =>
      planWarpRouteHybrids({
        multiProvider,
        warpDeployConfig: config({
          type: HookType.ROUTING,
          owner,
          domains: { test2: hybrid() },
        }),
      }),
    ).to.throw('only forwards some dispatches');
  });
});
