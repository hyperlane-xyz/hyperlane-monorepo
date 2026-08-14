import { expect } from 'chai';
import sinon from 'sinon';

import {
  type ForkedChainMetadata,
  ForkManagerRegistry,
  type IForkManager,
} from '@hyperlane-xyz/forking-sdk';
import { HttpServer } from '@hyperlane-xyz/http-registry-server';
import { PartialRegistry } from '@hyperlane-xyz/registry';
import { type ChainMetadata, MultiProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';

import { runForkCommand } from './fork.js';

const CHAIN = 'anvil2';
const RPC_URL = 'http://127.0.0.1:9545';

// Minimal fork manager that records start/kill without spawning anything, so we
// can exercise fork.ts's teardown/server-skip flow with no anvil/surfpool.
class FakeForkManager implements IForkManager<unknown> {
  startCount = 0;
  killCount = 0;

  constructor(private readonly port: number) {}

  async start(): Promise<void> {
    this.startCount++;
  }

  async applyForkConfig(): Promise<void> {}

  getForkedChainMetadata(): ForkedChainMetadata {
    return {
      rpcUrls: [{ http: `http://127.0.0.1:${this.port}` }],
      blocks: { confirmations: 1 },
    };
  }

  kill(): void {
    this.killCount++;
  }
}

const CHAIN_METADATA: ChainMetadata = {
  name: CHAIN,
  protocol: ProtocolType.Ethereum,
  chainId: 31337,
  domainId: 31337,
  rpcUrls: [{ http: RPC_URL }],
};

function makeContext(): Pick<CommandContext, 'registry' | 'multiProvider'> {
  const multiProvider = sinon.createStubInstance(MultiProvider);
  multiProvider.getProtocol.returns(ProtocolType.Ethereum);
  multiProvider.getChainMetadata.returns(CHAIN_METADATA);
  return {
    registry: new PartialRegistry({}),
    multiProvider,
  };
}

// Stub the registry so a supported chain builds our FakeForkManager (no dynamic
// import, no real anvil factory). `hasProtocol` true keeps the chain past the
// gate and short-circuits loadForkManager.
function stubRegistry(created: FakeForkManager[]): void {
  sinon.stub(ForkManagerRegistry.prototype, 'hasProtocol').returns(true);
  sinon
    .stub(ForkManagerRegistry.prototype, 'getForkManagerFactory')
    .returns((ctx) => {
      const manager = new FakeForkManager(ctx.port);
      created.push(manager);
      return manager;
    });
}

describe('runForkCommand --kill teardown', () => {
  afterEach(() => sinon.restore());

  it('kills every fork manager and skips the registry server when kill is set', async () => {
    const created: FakeForkManager[] = [];
    stubRegistry(created);
    const createStub = sinon.stub(HttpServer, 'create');

    await runForkCommand({
      context: makeContext(),
      // A supported chain with NO fork-config slice: it never self-killed under
      // the old per-manager logic, so it is the regression case.
      chainsToFork: new Set([CHAIN]),
      forkConfig: {},
      kill: true,
      basePort: 9545,
    });

    expect(created.length).to.equal(1);
    expect(created.every((manager) => manager.killCount === 1)).to.equal(true);
    expect(createStub.called).to.equal(false);
  });

  it('starts the registry server and does not kill when kill is not set', async () => {
    const created: FakeForkManager[] = [];
    stubRegistry(created);
    const serverStub = sinon.createStubInstance(HttpServer);
    const createStub = sinon.stub(HttpServer, 'create').resolves(serverStub);

    await runForkCommand({
      context: makeContext(),
      chainsToFork: new Set([CHAIN]),
      forkConfig: {},
      kill: false,
      basePort: 9545,
    });

    expect(created.length).to.equal(1);
    expect(created.every((manager) => manager.killCount === 0)).to.equal(true);
    expect(createStub.calledOnce).to.equal(true);
    expect(serverStub.start.calledOnce).to.equal(true);
  });

  it('kills every fork manager when registry server setup fails', async () => {
    const created: FakeForkManager[] = [];
    stubRegistry(created);
    sinon.stub(HttpServer, 'create').rejects(new Error('server setup failed'));

    let rejected: unknown;
    try {
      await runForkCommand({
        context: makeContext(),
        chainsToFork: new Set([CHAIN]),
        forkConfig: {},
        kill: false,
        basePort: 9545,
      });
    } catch (error: unknown) {
      rejected = error;
    }

    expect(rejected).to.be.instanceOf(Error);
    expect(created.length).to.equal(1);
    expect(created.every((manager) => manager.killCount === 1)).to.equal(true);
  });

  it('rejects without creating any fork manager when --port is too low', async () => {
    const created: FakeForkManager[] = [];
    stubRegistry(created);
    const createStub = sinon.stub(HttpServer, 'create');

    let rejected: unknown;
    try {
      await runForkCommand({
        context: makeContext(),
        chainsToFork: new Set([CHAIN]),
        forkConfig: {},
        kill: false,
        // basePort - 10 === 0: the registry server would bind an ephemeral port
        // and advertise no usable endpoint, so no fork must start.
        basePort: 10,
      });
    } catch (error: unknown) {
      rejected = error;
    }

    expect(rejected).to.be.instanceOf(Error);
    expect(created.length).to.equal(0);
    expect(createStub.called).to.equal(false);
  });

  it('kills every fork manager when the registry server fails to start', async () => {
    const created: FakeForkManager[] = [];
    stubRegistry(created);
    const serverStub = sinon.createStubInstance(HttpServer);
    serverStub.start.rejects(new Error('registry server bind failed'));
    sinon.stub(HttpServer, 'create').resolves(serverStub);

    let rejected: unknown;
    try {
      await runForkCommand({
        context: makeContext(),
        chainsToFork: new Set([CHAIN]),
        forkConfig: {},
        kill: false,
        basePort: 9545,
      });
    } catch (error: unknown) {
      rejected = error;
    }

    expect(rejected).to.be.instanceOf(Error);
    // Forks now spawn before the server starts; a rejected start() must tear
    // every one of them down.
    expect(created.length).to.equal(1);
    expect(created.every((manager) => manager.killCount === 1)).to.equal(true);
  });
});
