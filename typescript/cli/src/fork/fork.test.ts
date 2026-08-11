import { expect } from 'chai';
import sinon from 'sinon';

import { HttpServer } from '@hyperlane-xyz/http-registry-server';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { type CommandContext } from '../context/types.js';

import { runForkCommand } from './fork.js';

// A Cosmos chain is neither EVM-like nor registered as a forkable protocol, so
// the chain gate skips it and `buildForkedChainMetadata` runs over an empty
// chain set — no fork node (and no anvil/surfpool) is ever started. That lets
// us drive the post-fork server branch in isolation.
function makeContext(): CommandContext {
  const multiProvider = sinon.createStubInstance(MultiProvider);
  multiProvider.getProtocol.returns(ProtocolType.Cosmos);
  return {
    registry: {},
    multiProvider,
  } as unknown as CommandContext;
}

describe('runForkCommand registry server', () => {
  afterEach(() => sinon.restore());

  it('skips starting the registry server when kill is set', async () => {
    const createStub = sinon.stub(HttpServer, 'create');

    await runForkCommand({
      context: makeContext(),
      chainsToFork: new Set(['cosmoschain']),
      forkConfig: {},
      kill: true,
      basePort: 8545,
    });

    expect(createStub.called).to.equal(false);
  });

  it('starts the registry server when kill is not set', async () => {
    const serverStub = sinon.createStubInstance(HttpServer);
    const createStub = sinon.stub(HttpServer, 'create').resolves(serverStub);

    await runForkCommand({
      context: makeContext(),
      chainsToFork: new Set(['cosmoschain']),
      forkConfig: {},
      kill: false,
      basePort: 8545,
    });

    expect(createStub.calledOnce).to.equal(true);
    expect(serverStub.start.calledOnce).to.equal(true);
  });
});
