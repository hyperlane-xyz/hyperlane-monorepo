import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  addBridgesToMonitoredRoutes,
  addRebalancersToRouteGroups,
  buildRemoteRouterEnrollment,
  routeAddresses,
} from './RouteFixtureBuilder.js';
import type { TestChain } from '../fixtures/routes.js';

type TestRouteGroup = Record<TestChain, { address: string }>;

type TestRebalancerRouteGroup = Record<
  TestChain,
  { address: string; addRebalancer: (rebalancer: string) => Promise<void> }
>;

type TestBridgeRouteGroup = Record<
  TestChain,
  {
    address: string;
    addBridge: (destinationDomain: number, bridge: string) => Promise<void>;
  }
>;

const routeGroupEntries = <T extends TestRouteGroup>(
  group: T,
): Array<[TestChain, T[TestChain]]> => [
  ['anvil1', group.anvil1],
  ['anvil2', group.anvil2],
  ['anvil3', group.anvil3],
];

describe('RouteFixtureBuilder helpers', () => {
  const routeGroup = {
    anvil1: { address: '0x0000000000000000000000000000000000000001' },
    anvil2: { address: '0x0000000000000000000000000000000000000002' },
    anvil3: { address: '0x0000000000000000000000000000000000000003' },
  } satisfies TestRouteGroup;

  it('builds remote enrollment domains and padded routers', () => {
    const enrollment = buildRemoteRouterEnrollment(routeGroup, 'anvil1');

    expect(enrollment.remoteDomains).to.deep.equal([31338, 31339]);
    expect(enrollment.remoteRouters).to.deep.equal([
      ethers.utils.hexZeroPad(routeGroup.anvil2.address, 32),
      ethers.utils.hexZeroPad(routeGroup.anvil3.address, 32),
    ]);
  });

  it('builds chain address maps from route groups', () => {
    expect(routeAddresses(routeGroup)).to.deep.equal(
      Object.fromEntries(
        routeGroupEntries(routeGroup).map(([chain, route]) => [
          chain,
          route.address,
        ]),
      ),
    );
  });

  it('adds per-chain rebalancers to every route group', async () => {
    const calls: Array<{ chain: string; rebalancer: string }> = [];
    const routeGroups: TestRebalancerRouteGroup[] = [
      {
        anvil1: {
          address: routeGroup.anvil1.address,
          addRebalancer: async (rebalancer) => {
            calls.push({ chain: 'anvil1', rebalancer });
          },
        },
        anvil2: {
          address: routeGroup.anvil2.address,
          addRebalancer: async (rebalancer) => {
            calls.push({ chain: 'anvil2', rebalancer });
          },
        },
        anvil3: {
          address: routeGroup.anvil3.address,
          addRebalancer: async (rebalancer) => {
            calls.push({ chain: 'anvil3', rebalancer });
          },
        },
      },
    ];

    await addRebalancersToRouteGroups(routeGroups, (chain) =>
      chain === 'anvil3' ? ['deployer', 'inventory'] : ['deployer'],
    );

    expect(calls).to.deep.equal([
      { chain: 'anvil1', rebalancer: 'deployer' },
      { chain: 'anvil2', rebalancer: 'deployer' },
      { chain: 'anvil3', rebalancer: 'deployer' },
      { chain: 'anvil3', rebalancer: 'inventory' },
    ]);
  });

  it('adds local-chain bridge addresses for every remote destination', async () => {
    const calls: Array<{
      chain: string;
      destinationDomain: number;
      bridge: string;
    }> = [];
    const monitoredRouters: TestBridgeRouteGroup = {
      anvil1: {
        address: routeGroup.anvil1.address,
        addBridge: async (destinationDomain, bridge) => {
          calls.push({ chain: 'anvil1', destinationDomain, bridge });
        },
      },
      anvil2: {
        address: routeGroup.anvil2.address,
        addBridge: async (destinationDomain, bridge) => {
          calls.push({ chain: 'anvil2', destinationDomain, bridge });
        },
      },
      anvil3: {
        address: routeGroup.anvil3.address,
        addBridge: async (destinationDomain, bridge) => {
          calls.push({ chain: 'anvil3', destinationDomain, bridge });
        },
      },
    };
    const bridgeRouteGroups = [
      {
        anvil1: { address: '0x0000000000000000000000000000000000000011' },
        anvil2: { address: '0x0000000000000000000000000000000000000012' },
        anvil3: { address: '0x0000000000000000000000000000000000000013' },
      },
      {
        anvil1: { address: '0x0000000000000000000000000000000000000021' },
        anvil2: { address: '0x0000000000000000000000000000000000000022' },
        anvil3: { address: '0x0000000000000000000000000000000000000023' },
      },
    ] satisfies TestRouteGroup[];

    await addBridgesToMonitoredRoutes(monitoredRouters, bridgeRouteGroups);

    expect(calls).to.deep.equal([
      {
        chain: 'anvil1',
        destinationDomain: 31338,
        bridge: bridgeRouteGroups[0].anvil1.address,
      },
      {
        chain: 'anvil1',
        destinationDomain: 31338,
        bridge: bridgeRouteGroups[1].anvil1.address,
      },
      {
        chain: 'anvil1',
        destinationDomain: 31339,
        bridge: bridgeRouteGroups[0].anvil1.address,
      },
      {
        chain: 'anvil1',
        destinationDomain: 31339,
        bridge: bridgeRouteGroups[1].anvil1.address,
      },
      {
        chain: 'anvil2',
        destinationDomain: 31337,
        bridge: bridgeRouteGroups[0].anvil2.address,
      },
      {
        chain: 'anvil2',
        destinationDomain: 31337,
        bridge: bridgeRouteGroups[1].anvil2.address,
      },
      {
        chain: 'anvil2',
        destinationDomain: 31339,
        bridge: bridgeRouteGroups[0].anvil2.address,
      },
      {
        chain: 'anvil2',
        destinationDomain: 31339,
        bridge: bridgeRouteGroups[1].anvil2.address,
      },
      {
        chain: 'anvil3',
        destinationDomain: 31337,
        bridge: bridgeRouteGroups[0].anvil3.address,
      },
      {
        chain: 'anvil3',
        destinationDomain: 31337,
        bridge: bridgeRouteGroups[1].anvil3.address,
      },
      {
        chain: 'anvil3',
        destinationDomain: 31338,
        bridge: bridgeRouteGroups[0].anvil3.address,
      },
      {
        chain: 'anvil3',
        destinationDomain: 31338,
        bridge: bridgeRouteGroups[1].anvil3.address,
      },
    ]);
  });
});
