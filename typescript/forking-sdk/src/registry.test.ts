import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { ForkManagerRegistry } from './registry.js';
import {
  ForkManagerContext,
  ForkedChainMetadata,
  IForkManager,
} from './types.js';

function stubManager(): IForkManager<unknown> {
  const metadata: ForkedChainMetadata = {
    rpcUrls: [{ http: 'http://127.0.0.1:8545' }],
  };
  return {
    start: () => Promise.resolve(),
    applyForkConfig: () => Promise.resolve(),
    getForkedChainMetadata: () => metadata,
    kill: () => {},
  };
}

describe('ForkManagerRegistry', () => {
  it('registers, reports, and lists a protocol factory', () => {
    const registry = new ForkManagerRegistry();
    const factory = (_ctx: ForkManagerContext) => stubManager();

    expect(registry.hasProtocol(ProtocolType.Ethereum)).to.equal(false);
    registry.registerProtocol(ProtocolType.Ethereum, factory);

    expect(registry.hasProtocol(ProtocolType.Ethereum)).to.equal(true);
    expect(registry.listProtocols()).to.have.members([ProtocolType.Ethereum]);
  });

  it('returns the exact registered factory', () => {
    const registry = new ForkManagerRegistry();
    const factory = (_ctx: ForkManagerContext) => stubManager();
    registry.registerProtocol(ProtocolType.Sealevel, factory);

    const got = registry.getForkManagerFactory(ProtocolType.Sealevel);
    expect(got).to.equal(factory);
  });

  it('throws when registering the same protocol twice', () => {
    const registry = new ForkManagerRegistry();
    registry.registerProtocol(ProtocolType.Ethereum, () => stubManager());

    expect(() =>
      registry.registerProtocol(ProtocolType.Ethereum, () => stubManager()),
    ).to.throw(`Protocol '${ProtocolType.Ethereum}' is already registered`);
  });

  it('throws with the available list when protocol is not registered', () => {
    const registry = new ForkManagerRegistry();
    registry.registerProtocol(ProtocolType.Ethereum, () => stubManager());

    expect(() =>
      registry.getForkManagerFactory(ProtocolType.Sealevel),
    ).to.throw('Available protocols');
  });
});
