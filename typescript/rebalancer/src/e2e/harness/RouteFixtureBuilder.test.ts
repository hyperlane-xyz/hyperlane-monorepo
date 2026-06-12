import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  addBridgesToMonitoredRoutes,
  addRebalancersToRouteGroups,
  buildRemoteRouterEnrollment,
  routeAddresses,
} from './RouteFixtureBuilder.js';

describe('RouteFixtureBuilder helpers', () => {
  const routeGroup = {
    anvil1: { address: '0x0000000000000000000000000000000000000001' },
    anvil2: { address: '0x0000000000000000000000000000000000000002' },
    anvil3: { address: '0x0000000000000000000000000000000000000003' },
  };

  it('builds remote enrollment domains and padded routers', () => {
    const enrollment = buildRemoteRouterEnrollment(routeGroup, 'anvil1');

    expect(enrollment.remoteDomains).to.deep.equal([31338, 31339]);
    expect(enrollment.remoteRouters).to.deep.equal([
      ethers.utils.hexZeroPad(routeGroup.anvil2.address, 32),
      ethers.utils.hexZeroPad(routeGroup.anvil3.address, 32),
    ]);
  });

  it('builds chain address maps from route groups', () => {
    expect(routeAddresses(routeGroup)).to.deep.equal({
      anvil1: routeGroup.anvil1.address,
      anvil2: routeGroup.anvil2.address,
      anvil3: routeGroup.anvil3.address,
    });
  });

  it('adds per-chain rebalancers to every route group', async () => {
    const calls: Array<{ chain: string; rebalancer: string }> = [];
    const routeGroups = [
      Object.fromEntries(
        Object.keys(routeGroup).map((chain) => [
          chain,
          {
            address: routeGroup[chain as keyof typeof routeGroup].address,
            addRebalancer: async (rebalancer: string) => {
              calls.push({ chain, rebalancer });
            },
          },
        ]),
      ),
    ];

    await addRebalancersToRouteGroups(
      routeGroups as unknown as Parameters<
        typeof addRebalancersToRouteGroups
      >[0],
      (chain) =>
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
    const monitoredRouters = Object.fromEntries(
      Object.keys(routeGroup).map((chain) => [
        chain,
        {
          address: routeGroup[chain as keyof typeof routeGroup].address,
          addBridge: async (destinationDomain: number, bridge: string) => {
            calls.push({ chain, destinationDomain, bridge });
          },
        },
      ]),
    );
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
    ];

    await addBridgesToMonitoredRoutes(
      monitoredRouters as unknown as Parameters<
        typeof addBridgesToMonitoredRoutes
      >[0],
      bridgeRouteGroups as unknown as Parameters<
        typeof addBridgesToMonitoredRoutes
      >[1],
    );

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
