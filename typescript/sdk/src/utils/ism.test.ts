import { expect } from 'chai';
import { ethers } from 'ethers';

import { test1, test2, test3 } from '../consts/testChains.js';
import { IsmConfig, IsmType } from '../ism/types.js';
import { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import {
  type DelayedFlowRemoteIsmsSource,
  DelayedFlowRemoteIsmsSourceType,
  canonicalizeRemoteIsms,
  collectHybridIsmNodes,
  completeHybridIsmNodes,
  ismTreeContainsHybridHookIsm,
  prepareHybridIsmNodesForDeploy,
  resolveDelayedFlowRemoteIsms,
} from './ism.js';

const WARP_ROUTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEPLOYER = '0xdddddddddddddddddddddddddddddddddddddddd';
const DEFAULT_OWNER = '0xcccccccccccccccccccccccccccccccccccccccc';
const OWNER = '0x1111111111111111111111111111111111111111';
const RELAYER = '0x2222222222222222222222222222222222222222';
const REMOTE_ISM_BYTES32 = ethers.utils.hexZeroPad(
  '0x3333333333333333333333333333333333333333',
  32,
);
const STALE_REMOTE_ISM_BYTES32 = ethers.utils.hexZeroPad(
  '0x4444444444444444444444444444444444444444',
  32,
);

// The test chains all use chainId === domainId, which would let a chain-id key
// pass by coincidence. This one keeps the two apart.
const oddChain: ChainMetadata = {
  ...test1,
  name: 'oddchain',
  displayName: 'Odd Chain',
  chainId: 4242,
  domainId: 777777,
};

const chainLookup = new MultiProvider({
  test1,
  test2,
  test3,
  oddchain: oddChain,
});

const delayedNode = {
  type: IsmType.DELAYED_FLOW_ROUTER,
  thresholdBps: 10000,
  maxDelay: 3600,
  duration: 86400n,
  owner: OWNER,
} as const;

const netFlowNode = {
  type: IsmType.NET_FLOW_RATE_LIMITED,
  thresholdBps: 500,
  duration: 86400n,
  owner: OWNER,
} as const;

function aggregationOf(...modules: IsmConfig[]): IsmConfig {
  return {
    type: IsmType.AGGREGATION,
    threshold: modules.length,
    modules,
  };
}

describe('hybrid hook/ISM tree helpers', () => {
  describe('ismTreeContainsHybridHookIsm', () => {
    it('detects hybrid nodes nested in containers', () => {
      const tree = aggregationOf(
        { type: IsmType.TRUSTED_RELAYER, relayer: RELAYER },
        delayedNode,
      );
      expect(ismTreeContainsHybridHookIsm(tree)).to.be.true;
    });

    it('returns false for trees without hybrid nodes', () => {
      const tree = aggregationOf({
        type: IsmType.TRUSTED_RELAYER,
        relayer: RELAYER,
      });
      expect(ismTreeContainsHybridHookIsm(tree)).to.be.false;
    });
  });

  describe('collectHybridIsmNodes', () => {
    it('collects hybrid nodes across aggregation, routing, and amount routing containers', () => {
      const tree: IsmConfig = {
        type: IsmType.AMOUNT_ROUTING,
        threshold: 1,
        lowerIsm: aggregationOf(netFlowNode),
        upperIsm: {
          type: IsmType.ROUTING,
          owner: OWNER,
          domains: { test2: delayedNode },
        },
      };
      const nodes = collectHybridIsmNodes(tree);
      expect(nodes.map((node) => node.type)).to.have.members([
        IsmType.NET_FLOW_RATE_LIMITED,
        IsmType.DELAYED_FLOW_ROUTER,
      ]);
    });

    it('returns a hybrid node when it is the tree root', () => {
      expect(collectHybridIsmNodes(delayedNode)).to.deep.equal([delayedNode]);
    });
  });

  describe('prepareHybridIsmNodesForDeploy', () => {
    it('injects warpRouter and overrides DELAYED owner to the intermediate deployer, dropping remoteIsms', () => {
      const tree = aggregationOf(
        { type: IsmType.TRUSTED_RELAYER, relayer: RELAYER },
        {
          type: IsmType.DELAYED_FLOW_ROUTER,
          thresholdBps: 10000,
          maxDelay: 3600,
          duration: 86400n,
          owner: OWNER,
          remoteIsms: { test2: REMOTE_ISM_BYTES32 },
        },
      );
      const prepared = prepareHybridIsmNodesForDeploy(
        tree,
        WARP_ROUTER,
        DEPLOYER,
      );
      const nodes = collectHybridIsmNodes(prepared);
      expect(nodes).to.deep.equal([
        {
          type: IsmType.DELAYED_FLOW_ROUTER,
          warpRouter: WARP_ROUTER,
          thresholdBps: 10000,
          maxDelay: 3600,
          duration: 86400n,
          owner: DEPLOYER,
        },
      ]);
    });

    it('injects warpRouter and overrides NET_FLOW owner to the intermediate deployer', () => {
      const prepared = prepareHybridIsmNodesForDeploy(
        netFlowNode,
        WARP_ROUTER,
        DEPLOYER,
      );
      expect(prepared).to.deep.equal({
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: WARP_ROUTER,
        thresholdBps: 500,
        duration: 86400n,
        owner: DEPLOYER,
      });
    });

    it('overrides an omitted NET_FLOW owner to the intermediate deployer', () => {
      const ownerlessNetFlow: IsmConfig = {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        thresholdBps: 500,
        duration: 86400n,
      };
      const prepared = prepareHybridIsmNodesForDeploy(
        ownerlessNetFlow,
        WARP_ROUTER,
        DEPLOYER,
      );
      expect(prepared).to.deep.equal({
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: WARP_ROUTER,
        thresholdBps: 500,
        duration: 86400n,
        owner: DEPLOYER,
      });
    });

    it('leaves non-hybrid nodes untouched', () => {
      const tree = aggregationOf({
        type: IsmType.TRUSTED_RELAYER,
        relayer: RELAYER,
      });
      expect(
        prepareHybridIsmNodesForDeploy(tree, WARP_ROUTER, DEPLOYER),
      ).to.deep.equal(tree);
    });

    it('prepareHybridIsmNodesForDeploy rejects a warpRouter that disagrees with the containing router', () => {
      const foreignRouter: IsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: RELAYER,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: OWNER,
      };
      expect(() =>
        prepareHybridIsmNodesForDeploy(
          aggregationOf(foreignRouter),
          WARP_ROUTER,
          DEPLOYER,
        ),
      ).to.throw('installed on warp router');
    });

    it('accepts a warpRouter matching the containing router in any casing', () => {
      const explicitRouter: IsmConfig = {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: WARP_ROUTER.toUpperCase().replace('0X', '0x'),
        thresholdBps: 500,
        duration: 86400n,
        owner: OWNER,
      };
      expect(
        prepareHybridIsmNodesForDeploy(explicitRouter, WARP_ROUTER, DEPLOYER),
      ).to.deep.equal({
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: WARP_ROUTER,
        thresholdBps: 500,
        duration: 86400n,
        owner: DEPLOYER,
      });
    });
  });

  describe('canonicalizeRemoteIsms', () => {
    it('keys by chain name and normalizes the counterpart to lowercase bytes32', () => {
      expect(
        canonicalizeRemoteIsms(
          { test2: '0x3333333333333333333333333333333333333333' },
          chainLookup,
          'test',
        ),
      ).to.deep.equal({ test2: REMOTE_ISM_BYTES32 });
    });

    it('resolves a domain-id key to the same entry as the chain name', () => {
      expect(
        canonicalizeRemoteIsms(
          { [test2.domainId]: REMOTE_ISM_BYTES32 },
          chainLookup,
          'test',
        ),
      ).to.deep.equal({ test2: REMOTE_ISM_BYTES32 });
    });

    it('rejects a chain-id key that is not the chain domain id', () => {
      // deploy/update resolve keys through the registry, where a numeric key is
      // a domain id: taking a chain id here would enroll the wrong domain (or
      // none), and only after the contracts are on-chain.
      expect(() =>
        canonicalizeRemoteIsms(
          { [oddChain.chainId]: REMOTE_ISM_BYTES32 },
          chainLookup,
          'test',
        ),
      ).to.throw('resolves to no known chain');

      expect(
        canonicalizeRemoteIsms(
          { [oddChain.domainId]: REMOTE_ISM_BYTES32 },
          chainLookup,
          'test',
        ),
      ).to.deep.equal({ oddchain: REMOTE_ISM_BYTES32 });
    });

    it('rejects a misspelled chain rather than skipping it', () => {
      expect(() =>
        canonicalizeRemoteIsms(
          { tset2: REMOTE_ISM_BYTES32 },
          chainLookup,
          'test',
        ),
      ).to.throw("names 'tset2'");
    });

    it('rejects a chain named twice through two key forms', () => {
      // Both entries describe domain test2, which has a single on-chain
      // counterpart: submitting both can never converge.
      expect(() =>
        canonicalizeRemoteIsms(
          {
            test2: REMOTE_ISM_BYTES32,
            [test2.domainId]: REMOTE_ISM_BYTES32,
          },
          chainLookup,
          'test',
        ),
      ).to.throw('same chain test2');
    });
  });

  describe('resolveDelayedFlowRemoteIsms', () => {
    it('takes the derived pairing when the config omits the field', () => {
      expect(
        resolveDelayedFlowRemoteIsms(
          undefined,
          { test2: REMOTE_ISM_BYTES32 },
          'test',
          chainLookup,
        ),
      ).to.deep.equal({ test2: REMOTE_ISM_BYTES32 });
    });

    it('uses the route-derived pairing for an in-route chain while preserving external configured peers', () => {
      expect(
        resolveDelayedFlowRemoteIsms(
          {
            test2: STALE_REMOTE_ISM_BYTES32,
            test3: REMOTE_ISM_BYTES32,
          },
          { test2: REMOTE_ISM_BYTES32 },
          'test',
          chainLookup,
        ),
      ).to.deep.equal({
        test2: REMOTE_ISM_BYTES32,
        test3: REMOTE_ISM_BYTES32,
      });
    });

    it('keeps a configured pairing when nothing is derived', () => {
      expect(
        resolveDelayedFlowRemoteIsms(
          { test3: REMOTE_ISM_BYTES32 },
          undefined,
          'test',
          chainLookup,
        ),
      ).to.deep.equal({ test3: REMOTE_ISM_BYTES32 });
    });

    it('canonicalizes a configured pairing keyed by domain id', () => {
      // What `warp check` compares and what `warp apply` submits both come from
      // here, so a domain-keyed config must resolve to the chain-name form the
      // reader emits — otherwise the route reports drift forever.
      expect(
        resolveDelayedFlowRemoteIsms(
          { [test3.domainId]: REMOTE_ISM_BYTES32 },
          { test3: REMOTE_ISM_BYTES32 },
          'test',
          chainLookup,
        ),
      ).to.deep.equal({ test3: REMOTE_ISM_BYTES32 });
    });

    it('resolves to nothing when neither side has a pairing', () => {
      expect(
        resolveDelayedFlowRemoteIsms(undefined, undefined, 'test', chainLookup),
      ).to.be.undefined;
    });
  });

  describe('completeHybridIsmNodes', () => {
    const resolved = (
      derived: Record<string, string> | undefined,
    ): DelayedFlowRemoteIsmsSource => ({
      type: DelayedFlowRemoteIsmsSourceType.Resolved,
      derived,
    });
    const deferred: DelayedFlowRemoteIsmsSource = {
      type: DelayedFlowRemoteIsmsSourceType.Deferred,
    };

    it('fills missing warpRouter and remoteIsms', () => {
      const completed = completeHybridIsmNodes(
        delayedNode,
        WARP_ROUTER,
        resolved({ test2: REMOTE_ISM_BYTES32 }),
        DEFAULT_OWNER,
        chainLookup,
      );
      expect(completed).to.deep.equal({
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: WARP_ROUTER,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: OWNER,
        remoteIsms: { test2: REMOTE_ISM_BYTES32 },
      });
    });

    it('uses route-derived remoteIsms over a stale configured in-route pairing', () => {
      const userNode: IsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: WARP_ROUTER,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: OWNER,
        remoteIsms: { test2: STALE_REMOTE_ISM_BYTES32 },
      };
      const completed = completeHybridIsmNodes(
        userNode,
        WARP_ROUTER,
        resolved({ test2: REMOTE_ISM_BYTES32 }),
        DEFAULT_OWNER,
        chainLookup,
      );
      expect(completed).to.deep.equal({
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: WARP_ROUTER,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: OWNER,
        remoteIsms: { test2: REMOTE_ISM_BYTES32 },
      });
    });

    it('keeps a configured remoteIsms when no pairing is derived', () => {
      const userNode: IsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: WARP_ROUTER,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: OWNER,
        remoteIsms: { test3: REMOTE_ISM_BYTES32 },
      };
      const completed = completeHybridIsmNodes(
        userNode,
        WARP_ROUTER,
        resolved(undefined),
        DEFAULT_OWNER,
        chainLookup,
      );
      expect(completed).to.deep.equal({
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: WARP_ROUTER,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: OWNER,
        remoteIsms: { test3: REMOTE_ISM_BYTES32 },
      });
    });

    it('clears remoteIsms when the field is deferred to the enrollment pass', () => {
      const userNode: IsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: WARP_ROUTER,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: OWNER,
        remoteIsms: { test3: REMOTE_ISM_BYTES32 },
      };
      const completed = completeHybridIsmNodes(
        userNode,
        WARP_ROUTER,
        deferred,
        DEFAULT_OWNER,
        chainLookup,
      );
      expect(completed).to.deep.equal({
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: WARP_ROUTER,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: OWNER,
        remoteIsms: undefined,
      });
    });

    it('completeHybridIsmNodes rejects a warpRouter that disagrees with the containing router', () => {
      const foreignRouter: IsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: RELAYER,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: OWNER,
      };
      expect(() =>
        completeHybridIsmNodes(
          aggregationOf(foreignRouter),
          WARP_ROUTER,
          resolved(undefined),
          DEFAULT_OWNER,
          chainLookup,
        ),
      ).to.throw('installed on warp router');
    });

    it('fills warpRouter without a resolvable owner when nodes carry one', () => {
      const completed = completeHybridIsmNodes(
        aggregationOf(delayedNode, netFlowNode),
        WARP_ROUTER,
        resolved(undefined),
        undefined,
        chainLookup,
      );
      expect(collectHybridIsmNodes(completed)).to.deep.equal([
        {
          type: IsmType.DELAYED_FLOW_ROUTER,
          warpRouter: WARP_ROUTER,
          thresholdBps: 10000,
          maxDelay: 3600,
          duration: 86400n,
          owner: OWNER,
          remoteIsms: undefined,
        },
        {
          type: IsmType.NET_FLOW_RATE_LIMITED,
          warpRouter: WARP_ROUTER,
          thresholdBps: 500,
          duration: 86400n,
          owner: OWNER,
        },
      ]);
    });

    it('rejects a NET_FLOW node with neither an owner nor a resolvable default', () => {
      const ownerlessNetFlow: IsmConfig = {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        thresholdBps: 500,
        duration: 86400n,
      };
      expect(() =>
        completeHybridIsmNodes(
          ownerlessNetFlow,
          WARP_ROUTER,
          resolved(undefined),
          undefined,
          chainLookup,
        ),
      ).to.throw("omits 'owner'");
    });

    it('completes NET_FLOW nodes with warpRouter, preserving an explicit owner', () => {
      const completed = completeHybridIsmNodes(
        aggregationOf(netFlowNode),
        WARP_ROUTER,
        resolved(undefined),
        DEFAULT_OWNER,
        chainLookup,
      );
      expect(collectHybridIsmNodes(completed)).to.deep.equal([
        {
          type: IsmType.NET_FLOW_RATE_LIMITED,
          warpRouter: WARP_ROUTER,
          thresholdBps: 500,
          duration: 86400n,
          owner: OWNER,
        },
      ]);
    });

    it('completeHybridIsmNodes defaults an omitted NET_FLOW owner to the chain config owner', () => {
      const ownerlessNetFlow: IsmConfig = {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        thresholdBps: 500,
        duration: 86400n,
      };
      const completed = completeHybridIsmNodes(
        ownerlessNetFlow,
        WARP_ROUTER,
        resolved(undefined),
        DEFAULT_OWNER,
        chainLookup,
      );
      expect(completed).to.deep.equal({
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: WARP_ROUTER,
        thresholdBps: 500,
        duration: 86400n,
        owner: DEFAULT_OWNER,
      });
    });
  });
});
