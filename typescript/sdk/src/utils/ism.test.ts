import { expect } from 'chai';

import { IsmConfig, IsmType } from '../ism/types.js';

import {
  assertHybridIsmDeployConstraints,
  collectHybridIsmNodes,
  completeHybridIsmNodes,
  fillHybridIsmOwnerDefaults,
  ismTreeContainsDeferredIsm,
  ismTreeContainsHybridHookIsm,
  prepareHybridIsmNodesForDeploy,
} from './ism.js';

const WARP_ROUTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEPLOYER = '0xdddddddddddddddddddddddddddddddddddddddd';
const DEFAULT_OWNER = '0xcccccccccccccccccccccccccccccccccccccccc';
const OWNER = '0x1111111111111111111111111111111111111111';
const RELAYER = '0x2222222222222222222222222222222222222222';
const REMOTE_ISM_BYTES32 =
  '0x0000000000000000000000003333333333333333333333333333333333333333';

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
  describe('ismTreeContainsDeferredIsm / ismTreeContainsHybridHookIsm', () => {
    it('detects hybrid nodes nested in containers', () => {
      const tree = aggregationOf(
        { type: IsmType.TRUSTED_RELAYER, relayer: RELAYER },
        delayedNode,
      );
      expect(ismTreeContainsHybridHookIsm(tree)).to.be.true;
      expect(ismTreeContainsDeferredIsm(tree)).to.be.true;
    });

    it('detects RATE_LIMITED as deferred but not hybrid', () => {
      const tree = aggregationOf({
        type: IsmType.RATE_LIMITED,
        maxCapacity: '86400',
        duration: 86400n,
      });
      expect(ismTreeContainsHybridHookIsm(tree)).to.be.false;
      expect(ismTreeContainsDeferredIsm(tree)).to.be.true;
    });

    it('returns false for trees without deferred nodes', () => {
      const tree = aggregationOf({
        type: IsmType.TRUSTED_RELAYER,
        relayer: RELAYER,
      });
      expect(ismTreeContainsHybridHookIsm(tree)).to.be.false;
      expect(ismTreeContainsDeferredIsm(tree)).to.be.false;
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
        DEFAULT_OWNER,
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

    it('injects warpRouter into NET_FLOW nodes but preserves their owner', () => {
      const prepared = prepareHybridIsmNodesForDeploy(
        netFlowNode,
        WARP_ROUTER,
        DEPLOYER,
        DEFAULT_OWNER,
      );
      expect(prepared).to.deep.equal({
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: WARP_ROUTER,
        thresholdBps: 500,
        duration: 86400n,
        owner: OWNER,
      });
    });

    it('defaults an omitted NET_FLOW owner to the chain config owner', () => {
      const ownerlessNetFlow: IsmConfig = {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        thresholdBps: 500,
        duration: 86400n,
      };
      const prepared = prepareHybridIsmNodesForDeploy(
        ownerlessNetFlow,
        WARP_ROUTER,
        DEPLOYER,
        DEFAULT_OWNER,
      );
      expect(prepared).to.deep.equal({
        type: IsmType.NET_FLOW_RATE_LIMITED,
        warpRouter: WARP_ROUTER,
        thresholdBps: 500,
        duration: 86400n,
        owner: DEFAULT_OWNER,
      });
    });

    it('leaves non-hybrid nodes untouched', () => {
      const tree = aggregationOf({
        type: IsmType.TRUSTED_RELAYER,
        relayer: RELAYER,
      });
      expect(
        prepareHybridIsmNodesForDeploy(
          tree,
          WARP_ROUTER,
          DEPLOYER,
          DEFAULT_OWNER,
        ),
      ).to.deep.equal(tree);
    });
  });

  describe('fillHybridIsmOwnerDefaults', () => {
    it('fills omitted NET_FLOW owners but keeps explicit ones and DELAYED nodes untouched', () => {
      const ownerlessNetFlow: IsmConfig = {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        thresholdBps: 500,
        duration: 86400n,
      };
      const filled = fillHybridIsmOwnerDefaults(
        aggregationOf(ownerlessNetFlow),
        DEFAULT_OWNER,
      );
      expect(collectHybridIsmNodes(filled)).to.deep.equal([
        {
          type: IsmType.NET_FLOW_RATE_LIMITED,
          warpRouter: undefined,
          thresholdBps: 500,
          duration: 86400n,
          owner: DEFAULT_OWNER,
        },
      ]);

      expect(
        fillHybridIsmOwnerDefaults(netFlowNode, DEFAULT_OWNER),
      ).to.deep.equal(netFlowNode);
      expect(
        fillHybridIsmOwnerDefaults(delayedNode, DEFAULT_OWNER),
      ).to.deep.equal(delayedNode);
    });
  });

  describe('assertHybridIsmDeployConstraints', () => {
    const tree = aggregationOf(
      { type: IsmType.TRUSTED_RELAYER, relayer: RELAYER },
      delayedNode,
    );

    it('accepts a single-hybrid tree with no hook and no foreignDeployment', () => {
      expect(() =>
        assertHybridIsmDeployConstraints('test1', tree, {}),
      ).to.not.throw();
    });

    it('rejects a foreignDeployment chain', () => {
      expect(() =>
        assertHybridIsmDeployConstraints('test1', tree, {
          foreignDeployment: WARP_ROUTER,
        }),
      ).to.throw('foreignDeployment');
    });

    it('rejects a user-specified hook', () => {
      expect(() =>
        assertHybridIsmDeployConstraints('test1', tree, {
          hook: WARP_ROUTER,
        }),
      ).to.throw("'hook' must be unset");
    });

    it('rejects a config that also sets a predicateWrapper', () => {
      expect(() =>
        assertHybridIsmDeployConstraints('test1', tree, {
          predicateWrapper: { predicateRegistry: WARP_ROUTER, policyId: '1' },
        }),
      ).to.throw('both must own');
    });

    it('rejects more than one hybrid node in the tree', () => {
      const twoHybrids = aggregationOf(netFlowNode, delayedNode);
      expect(() =>
        assertHybridIsmDeployConstraints('test1', twoHybrids, {}),
      ).to.throw('found 2');
    });
  });

  describe('completeHybridIsmNodes', () => {
    it('fills missing warpRouter and remoteIsms', () => {
      const completed = completeHybridIsmNodes(
        delayedNode,
        WARP_ROUTER,
        { test2: REMOTE_ISM_BYTES32 },
        DEFAULT_OWNER,
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

    it('keeps user-specified warpRouter and remoteIsms', () => {
      const userNode: IsmConfig = {
        type: IsmType.DELAYED_FLOW_ROUTER,
        warpRouter: RELAYER,
        thresholdBps: 10000,
        maxDelay: 3600,
        duration: 86400n,
        owner: OWNER,
        remoteIsms: { test3: REMOTE_ISM_BYTES32 },
      };
      const completed = completeHybridIsmNodes(
        userNode,
        WARP_ROUTER,
        { test2: REMOTE_ISM_BYTES32 },
        DEFAULT_OWNER,
      );
      expect(completed).to.deep.equal(userNode);
    });

    it('completes NET_FLOW nodes with warpRouter, preserving an explicit owner', () => {
      const completed = completeHybridIsmNodes(
        aggregationOf(netFlowNode),
        WARP_ROUTER,
        undefined,
        DEFAULT_OWNER,
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

    it('defaults an omitted NET_FLOW owner to the chain config owner', () => {
      const ownerlessNetFlow: IsmConfig = {
        type: IsmType.NET_FLOW_RATE_LIMITED,
        thresholdBps: 500,
        duration: 86400n,
      };
      const completed = completeHybridIsmNodes(
        ownerlessNetFlow,
        WARP_ROUTER,
        undefined,
        DEFAULT_OWNER,
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
