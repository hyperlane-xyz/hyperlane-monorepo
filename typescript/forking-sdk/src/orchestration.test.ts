import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { buildForkedChainMetadata } from './orchestration.js';
import { ForkManagerRegistry } from './registry.js';
import {
  ForkChainInput,
  ForkManagerContext,
  ForkedChainMetadata,
  IForkManager,
} from './types.js';

class FakeForkManager implements IForkManager<unknown> {
  startCalls = 0;
  appliedConfigs: unknown[] = [];
  killed = false;
  failStart = false;

  constructor(readonly ctx: ForkManagerContext) {}

  start(): Promise<void> {
    this.startCalls++;
    if (this.failStart) {
      return Promise.reject(
        new Error(`start failed for ${this.ctx.chainName}`),
      );
    }
    return Promise.resolve();
  }

  applyForkConfig(config: unknown): Promise<void> {
    this.appliedConfigs.push(config);
    return Promise.resolve();
  }

  getForkedChainMetadata(): ForkedChainMetadata {
    return {
      rpcUrls: [{ http: `http://127.0.0.1:${this.ctx.port}` }],
      blocks: { confirmations: 1 },
    };
  }

  kill(): void {
    this.killed = true;
  }
}

function setup() {
  const created: FakeForkManager[] = [];
  const registry = new ForkManagerRegistry();
  const factory = (ctx: ForkManagerContext) => {
    const manager = new FakeForkManager(ctx);
    created.push(manager);
    return manager;
  };
  registry.registerProtocol(ProtocolType.Ethereum, factory);
  return { created, registry };
}

describe('buildForkedChainMetadata', () => {
  const chains: ForkChainInput[] = [
    {
      chainName: 'alpha',
      protocol: ProtocolType.Ethereum,
      upstreamRpcUrl: 'https://alpha.example',
      forkConfig: { tag: 'alpha-config' },
    },
    {
      chainName: 'beta',
      protocol: ProtocolType.Ethereum,
      upstreamRpcUrl: 'https://beta.example',
    },
    {
      chainName: 'gamma',
      protocol: ProtocolType.Ethereum,
      upstreamRpcUrl: 'https://gamma.example',
      forkConfig: { tag: 'gamma-config' },
    },
  ];

  it('allocates sequential ports and passes the correct context per chain', async () => {
    const { created, registry } = setup();

    await buildForkedChainMetadata({
      chains,
      forkManagers: registry,
      basePort: 9000,
    });

    expect(created.map((m) => m.ctx.port)).to.deep.equal([9000, 9001, 9002]);
    expect(created.map((m) => m.ctx.wsPort)).to.deep.equal([9003, 9004, 9005]);
    expect(created.map((m) => m.ctx.chainName)).to.deep.equal([
      'alpha',
      'beta',
      'gamma',
    ]);
    expect(created.map((m) => m.ctx.upstreamRpcUrl)).to.deep.equal([
      'https://alpha.example',
      'https://beta.example',
      'https://gamma.example',
    ]);
  });

  it('starts every manager exactly once', async () => {
    const { created, registry } = setup();

    await buildForkedChainMetadata({
      chains,
      forkManagers: registry,
      basePort: 9000,
    });

    expect(created.map((m) => m.startCalls)).to.deep.equal([1, 1, 1]);
  });

  it('applies fork config only for chains that supply one', async () => {
    const { created, registry } = setup();

    await buildForkedChainMetadata({
      chains,
      forkManagers: registry,
      basePort: 9000,
    });

    expect(created[0].appliedConfigs).to.deep.equal([{ tag: 'alpha-config' }]);
    expect(created[1].appliedConfigs).to.deep.equal([]);
    expect(created[2].appliedConfigs).to.deep.equal([{ tag: 'gamma-config' }]);
  });

  it('collects each manager forked-chain metadata keyed by chain name', async () => {
    const { created, registry } = setup();

    const { metadata, managers } = await buildForkedChainMetadata({
      chains,
      forkManagers: registry,
      basePort: 9000,
    });

    expect(Object.keys(metadata)).to.deep.equal(['alpha', 'beta', 'gamma']);
    expect(metadata.alpha).to.deep.equal(created[0].getForkedChainMetadata());
    expect(metadata.alpha.rpcUrls).to.deep.equal([
      { http: 'http://127.0.0.1:9000' },
    ]);
    expect(metadata.gamma.rpcUrls).to.deep.equal([
      { http: 'http://127.0.0.1:9002' },
    ]);
    expect(managers.beta).to.equal(created[1]);
  });

  it('rejects duplicate chain names before starting any node', async () => {
    const { created, registry } = setup();

    const duplicatedChains: ForkChainInput[] = [
      {
        chainName: 'alpha',
        protocol: ProtocolType.Ethereum,
        upstreamRpcUrl: 'https://alpha.example',
      },
      {
        chainName: 'alpha',
        protocol: ProtocolType.Ethereum,
        upstreamRpcUrl: 'https://alpha-2.example',
      },
    ];

    let threw = false;
    try {
      await buildForkedChainMetadata({
        chains: duplicatedChains,
        forkManagers: registry,
        basePort: 9000,
      });
    } catch (error: unknown) {
      threw = true;
      expect(error).to.be.instanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).to.include('alpha');
      }
    }

    expect(threw).to.equal(true);
    // No manager is created or started: the guard runs before the loop.
    expect(created.length).to.equal(0);
  });

  it('kills previously-started managers when a later manager fails to start', async () => {
    const created: FakeForkManager[] = [];
    const registry = new ForkManagerRegistry();
    const factory = (ctx: ForkManagerContext) => {
      const manager = new FakeForkManager(ctx);
      if (ctx.chainName === 'beta') {
        manager.failStart = true;
      }
      created.push(manager);
      return manager;
    };
    registry.registerProtocol(ProtocolType.Ethereum, factory);

    let threw = false;
    try {
      await buildForkedChainMetadata({
        chains,
        forkManagers: registry,
        basePort: 9000,
      });
    } catch (error: unknown) {
      threw = true;
      expect(error).to.be.instanceOf(Error);
    }

    expect(threw).to.equal(true);
    // gamma is never created: the loop throws while starting beta.
    expect(created.length).to.equal(2);
    // alpha (already started) is torn down during cleanup.
    expect(created[0].killed).to.equal(true);
  });
});
