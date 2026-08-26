import { expect } from 'chai';
import { pino } from 'pino';
import Sinon from 'sinon';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { getRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';

import { RebalancerConfig } from '../config/RebalancerConfig.js';
import { Mutex } from '../utils/mutex.js';

import {
  type FleetMember,
  RebalancerFleet,
  type RebalancerFleetOptions,
} from './RebalancerFleet.js';
import { type RebalancerServiceConfig } from './RebalancerService.js';

const testLogger = pino({ level: 'silent' });

function pending(): Promise<void> {
  return new Promise(() => undefined);
}

class ControlledService {
  readonly start: Sinon.SinonStub<[], Promise<void>>;
  readonly gracefulShutdown: Sinon.SinonStub<[], Promise<void>> = Sinon.stub<
    [],
    Promise<void>
  >().resolves();

  constructor(startBehavior: () => Promise<void>) {
    this.start = Sinon.stub<[], Promise<void>>().callsFake(startBehavior);
  }
}

interface TestFleetHarness {
  fleet: RebalancerFleet;
  serviceConfigs: RebalancerServiceConfig[];
  services: Map<string, ControlledService[]>;
}

function createFleetHarness(
  warpRouteIds: string[],
  buildService: (
    warpRouteId: string,
    instanceIndex: number,
  ) => ControlledService = () => new ControlledService(pending),
  options: Partial<RebalancerFleetOptions> = {},
): TestFleetHarness {
  const serviceConfigs: RebalancerServiceConfig[] = [];
  const services = new Map<string, ControlledService[]>();

  class TestRebalancerFleet extends RebalancerFleet {
    protected override createService(
      member: FleetMember,
      serviceConfig: RebalancerServiceConfig,
    ): ControlledService {
      serviceConfigs.push(serviceConfig);
      const warpRouteId = member.rebalancerConfig.warpRouteId;
      const routeServices = services.get(warpRouteId) ?? [];
      const service = buildService(warpRouteId, routeServices.length);
      routeServices.push(service);
      services.set(warpRouteId, routeServices);
      return service;
    }
  }

  const members = warpRouteIds.map((warpRouteId) => ({
    rebalancerConfig: new RebalancerConfig(warpRouteId, [], 60_000),
  }));
  const registry = getRegistry({
    registryUris: [DEFAULT_GITHUB_REGISTRY],
    enableProxy: false,
  });
  const fleet = new TestRebalancerFleet(
    new MultiProvider({}),
    registry,
    members,
    {
      checkFrequency: 60_000,
      monitorOnly: false,
      withMetrics: false,
      ...options,
    },
    testLogger,
  );

  return { fleet, serviceConfigs, services };
}

function getServices(
  harness: TestFleetHarness,
  warpRouteId: string,
): ControlledService[] {
  return harness.services.get(warpRouteId) ?? [];
}

describe('RebalancerFleet', () => {
  let sandbox: Sinon.SinonSandbox;
  let activeFleets: RebalancerFleet[];

  beforeEach(() => {
    sandbox = Sinon.createSandbox();
    activeFleets = [];
  });

  afterEach(async () => {
    await Promise.all(activeFleets.map((fleet) => fleet.stop()));
    sandbox.restore();
  });

  it('rejects duplicate warpRouteIds', () => {
    expect(() => createFleetHarness(['USDC/route', 'USDC/route'])).to.throw(
      'warpRouteIds must be unique',
    );
  });

  it('passes one execution lock and ownsProcess false to all members', () => {
    const harness = createFleetHarness(['USDC/one', 'USDC/two']);
    activeFleets.push(harness.fleet);

    expect(harness.serviceConfigs).to.have.lengthOf(2);
    expect(harness.serviceConfigs[0]?.ownsProcess).to.equal(false);
    expect(harness.serviceConfigs[1]?.ownsProcess).to.equal(false);
    expect(harness.serviceConfigs[0]?.executionLock).to.be.instanceOf(Mutex);
    expect(harness.serviceConfigs[0]?.executionLock).to.equal(
      harness.serviceConfigs[1]?.executionLock,
    );
  });

  it('staggers member starts', async () => {
    const clock = sandbox.useFakeTimers();
    const harness = createFleetHarness(['USDC/one', 'USDC/two'], undefined, {
      staggerMs: 5_000,
    });
    activeFleets.push(harness.fleet);

    const startPromise = harness.fleet.start();
    await clock.tickAsync(0);

    expect(getServices(harness, 'USDC/one')[0]?.start.calledOnce).to.equal(
      true,
    );
    expect(getServices(harness, 'USDC/two')[0]?.start.called).to.equal(false);

    await clock.tickAsync(4_999);
    expect(getServices(harness, 'USDC/two')[0]?.start.called).to.equal(false);

    await clock.tickAsync(1);
    expect(getServices(harness, 'USDC/two')[0]?.start.calledOnce).to.equal(
      true,
    );

    await harness.fleet.stop();
    await startPromise;
  });

  it('recreates failed members with capped exponential backoff', async () => {
    const clock = sandbox.useFakeTimers();
    const harness = createFleetHarness(
      ['USDC/failing', 'USDC/healthy'],
      (warpRouteId, instanceIndex) =>
        new ControlledService(
          warpRouteId === 'USDC/failing' && instanceIndex < 7
            ? () => Promise.reject(new Error(`failure ${instanceIndex}`))
            : pending,
        ),
      { staggerMs: 0 },
    );
    activeFleets.push(harness.fleet);

    const startPromise = harness.fleet.start();
    await clock.tickAsync(0);

    expect(getServices(harness, 'USDC/failing')).to.have.lengthOf(1);
    expect(getServices(harness, 'USDC/healthy')).to.have.lengthOf(1);
    expect(getServices(harness, 'USDC/healthy')[0]?.start.calledOnce).to.equal(
      true,
    );

    const backoffs = [
      30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
    ];
    for (const [index, delayMs] of backoffs.entries()) {
      await clock.tickAsync(delayMs - 1);
      expect(getServices(harness, 'USDC/failing')).to.have.lengthOf(index + 1);
      await clock.tickAsync(1);
      expect(getServices(harness, 'USDC/failing')).to.have.lengthOf(index + 2);
    }

    expect(getServices(harness, 'USDC/healthy')).to.have.lengthOf(1);
    expect(getServices(harness, 'USDC/healthy')[0]?.start.calledOnce).to.equal(
      true,
    );

    await harness.fleet.stop();
    await startPromise;
  });

  it('does not restart after stop during backoff', async () => {
    const clock = sandbox.useFakeTimers();
    const exitStub = sandbox.stub(process, 'exit');
    const harness = createFleetHarness(
      ['USDC/failing', 'USDC/healthy'],
      (warpRouteId) =>
        new ControlledService(
          warpRouteId === 'USDC/failing'
            ? () => Promise.reject(new Error('failure'))
            : pending,
        ),
      { staggerMs: 0 },
    );
    activeFleets.push(harness.fleet);

    const startPromise = harness.fleet.start();
    await clock.tickAsync(0);
    await harness.fleet.stop();
    await startPromise;

    for (const services of harness.services.values()) {
      expect(services).to.have.lengthOf(1);
      expect(services[0]?.gracefulShutdown.calledOnce).to.equal(true);
    }

    await clock.tickAsync(30_000);
    expect(getServices(harness, 'USDC/failing')).to.have.lengthOf(1);
    expect(exitStub.called).to.equal(false);
  });

  it('registers only fleet-level signal handlers', async () => {
    const clock = sandbox.useFakeTimers();
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    const harness = createFleetHarness(['USDC/one', 'USDC/two', 'USDC/three']);
    activeFleets.push(harness.fleet);

    const startPromise = harness.fleet.start();
    await clock.tickAsync(0);

    expect(process.listenerCount('SIGINT')).to.equal(sigintListeners + 1);
    expect(process.listenerCount('SIGTERM')).to.equal(sigtermListeners + 1);
    expect(
      harness.serviceConfigs.every(({ ownsProcess }) => !ownsProcess),
    ).to.equal(true);

    await harness.fleet.stop();
    await startPromise;
    expect(process.listenerCount('SIGINT')).to.equal(sigintListeners);
    expect(process.listenerCount('SIGTERM')).to.equal(sigtermListeners);
  });
});
