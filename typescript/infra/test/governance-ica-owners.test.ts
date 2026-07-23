import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import { ISafe__factory } from '@hyperlane-xyz/core';
import {
  type AccountConfig,
  type InterchainAccount,
  type MultiProvider,
} from '@hyperlane-xyz/sdk';

import {
  type GovernanceIcaOwnerDeclaration,
  resolveAcceptedInactiveOwners,
  verifyGovernanceIcaOwner,
} from '../scripts/check/governance-ica-owners.js';

describe('verifyGovernanceIcaOwner', () => {
  const DESTINATION = 'tron';
  const DECLARED_ICA = '0xB960616C7E2ee0F2a296A4b2B9D0b3308E23A69D';
  const ORIGIN_OWNER = '0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6';

  afterEach(() => {
    sinon.restore();
  });

  // Minimal InterchainAccount double: the resolver only calls getAccount.
  function buildIca(
    getAccount: (chain: string, config: AccountConfig) => Promise<string>,
  ): InterchainAccount {
    // CAST: test double exercising only the one member the resolver reads.
    return { getAccount } as unknown as InterchainAccount;
  }

  // Minimal MultiProvider double whose getProvider can be stubbed so a test can
  // assert which chain's provider is fetched (it's passed into
  // ISafe__factory.connect).
  function buildMultiProvider(
    getProvider: (chain: string) => unknown = () => ({}),
  ): MultiProvider {
    // CAST: test double exercising only getProvider.
    return { getProvider } as unknown as MultiProvider;
  }

  function stubSafeThreshold(threshold: number) {
    return sinon.stub(ISafe__factory, 'connect').returns(
      // CAST: only getThreshold() is read from the connected Safe.
      {
        getThreshold: async () => BigNumber.from(threshold),
      } as ReturnType<typeof ISafe__factory.connect>,
    );
  }

  function declaration(
    accountConfig: AccountConfig,
  ): GovernanceIcaOwnerDeclaration {
    return {
      warpRouteId: 'USDT/eclipsemainnet',
      destination: DESTINATION,
      declaredIca: DECLARED_ICA,
      accountConfig,
    };
  }

  it('accepts a matching ICA whose non-ethereum origin owner is a Safe with threshold > 1', async () => {
    const connectStub = stubSafeThreshold(3);
    const getAccountStub = sinon.stub().resolves(DECLARED_ICA);
    // Sentinel provider so we can assert it flows origin -> getProvider -> connect.
    const originProvider = { sentinel: 'arbitrum-provider' };
    const getProviderStub = sinon.stub().returns(originProvider);
    // Origin is arbitrum, NOT ethereum — proves the origin comes from the
    // declaration and is never assumed to be ethereum.
    const accountConfig: AccountConfig = {
      origin: 'arbitrum',
      owner: ORIGIN_OWNER,
    };

    const result = await verifyGovernanceIcaOwner({
      declaration: declaration(accountConfig),
      interchainAccount: buildIca(getAccountStub),
      multiProvider: buildMultiProvider(getProviderStub),
    });

    expect(result).to.deep.equal({ chain: DESTINATION, owner: DECLARED_ICA });
    // Derivation used the declared destination + accountConfig verbatim.
    expect(getAccountStub.calledOnceWith(DESTINATION, accountConfig)).to.equal(
      true,
    );
    // The Safe RPC used the declared origin's provider: a reintroduced Ethereum
    // hardcode (getProvider('ethereum')) would fail these assertions.
    expect(getProviderStub.calledOnceWithExactly('arbitrum')).to.equal(true);
    expect(connectStub.calledOnce).to.equal(true);
    expect(connectStub.firstCall.args[0]).to.equal(ORIGIN_OWNER);
    expect(connectStub.firstCall.args[1]).to.equal(originProvider);
  });

  it('fails closed for a matching ICA whose origin owner is a 1-of-1 Safe', async () => {
    stubSafeThreshold(1);
    const result = await verifyGovernanceIcaOwner({
      declaration: declaration({ origin: 'ethereum', owner: ORIGIN_OWNER }),
      interchainAccount: buildIca(async () => DECLARED_ICA),
      multiProvider: buildMultiProvider(),
    });

    expect(result).to.equal(undefined);
  });

  it('fails closed when the derived ICA does not match the declared ICA', async () => {
    const connectStub = stubSafeThreshold(3);
    const result = await verifyGovernanceIcaOwner({
      declaration: declaration({ origin: 'ethereum', owner: ORIGIN_OWNER }),
      interchainAccount: buildIca(
        async () => '0x3333333333333333333333333333333333333333',
      ),
      multiProvider: buildMultiProvider(),
    });

    expect(result).to.equal(undefined);
    // A derivation mismatch fails before the Safe threshold is ever read.
    expect(connectStub.notCalled).to.equal(true);
  });

  it('fails closed when ICA derivation throws', async () => {
    const result = await verifyGovernanceIcaOwner({
      declaration: declaration({ origin: 'ethereum', owner: ORIGIN_OWNER }),
      interchainAccount: buildIca(async () => {
        throw new Error('derivation failed');
      }),
      multiProvider: buildMultiProvider(),
    });

    expect(result).to.equal(undefined);
  });

  it('fails closed when the origin Safe check reverts (RPC failure / non-Safe owner)', async () => {
    sinon.stub(ISafe__factory, 'connect').returns(
      // CAST: simulate a non-Safe owner / RPC failure where getThreshold reverts.
      {
        getThreshold: async (): Promise<BigNumber> => {
          throw new Error('not a safe');
        },
      } as ReturnType<typeof ISafe__factory.connect>,
    );
    const result = await verifyGovernanceIcaOwner({
      declaration: declaration({ origin: 'ethereum', owner: ORIGIN_OWNER }),
      interchainAccount: buildIca(async () => DECLARED_ICA),
      multiProvider: buildMultiProvider(),
    });

    expect(result).to.equal(undefined);
  });
});

describe('resolveAcceptedInactiveOwners', () => {
  const DECLARED_ICA = '0xB960616C7E2ee0F2a296A4b2B9D0b3308E23A69D';

  afterEach(() => {
    sinon.restore();
  });

  function buildIca(
    getAccount: (chain: string, config: AccountConfig) => Promise<string>,
  ): InterchainAccount {
    // CAST: test double exercising only getAccount.
    return { getAccount } as unknown as InterchainAccount;
  }

  function buildMultiProvider(): MultiProvider {
    // CAST: test double exercising only getProvider.
    return { getProvider: () => ({}) } as unknown as MultiProvider;
  }

  it('returns an empty list when there is no declaration for the route', async () => {
    const result = await resolveAcceptedInactiveOwners({
      warpRouteId: 'UNKNOWN/route',
      interchainAccount: buildIca(async () => DECLARED_ICA),
      multiProvider: buildMultiProvider(),
    });

    expect(result).to.deep.equal([]);
  });

  it('resolves the declared route to its accepted verdict when derivation + Safe check pass', async () => {
    sinon.stub(ISafe__factory, 'connect').returns(
      // CAST: only getThreshold() is read from the connected Safe.
      {
        getThreshold: async () => BigNumber.from(3),
      } as ReturnType<typeof ISafe__factory.connect>,
    );

    const result = await resolveAcceptedInactiveOwners({
      warpRouteId: 'USDT/eclipsemainnet',
      interchainAccount: buildIca(async () => DECLARED_ICA),
      multiProvider: buildMultiProvider(),
    });

    expect(result).to.deep.equal([{ chain: 'tron', owner: DECLARED_ICA }]);
  });

  it('drops the verdict (fail closed) when the declared route derivation mismatches', async () => {
    const result = await resolveAcceptedInactiveOwners({
      warpRouteId: 'USDT/eclipsemainnet',
      interchainAccount: buildIca(
        async () => '0x3333333333333333333333333333333333333333',
      ),
      multiProvider: buildMultiProvider(),
    });

    expect(result).to.deep.equal([]);
  });

  it('skips resolution entirely when the declaration destination is outside the scoped chains', async () => {
    const getAccountStub = sinon.stub().resolves(DECLARED_ICA);
    const connectStub = sinon.stub(ISafe__factory, 'connect');

    const result = await resolveAcceptedInactiveOwners({
      warpRouteId: 'USDT/eclipsemainnet',
      interchainAccount: buildIca(getAccountStub),
      multiProvider: buildMultiProvider(),
      // A --chains ethereum check of a route whose only declaration targets tron:
      // the excluded leaf must never trigger derivation or the Safe RPC.
      destinations: ['ethereum'],
    });

    expect(result).to.deep.equal([]);
    expect(getAccountStub.notCalled).to.equal(true);
    expect(connectStub.notCalled).to.equal(true);
  });

  it('resolves the declaration when its destination is within the scoped chains', async () => {
    sinon.stub(ISafe__factory, 'connect').returns(
      // CAST: only getThreshold() is read from the connected Safe.
      {
        getThreshold: async () => BigNumber.from(3),
      } as ReturnType<typeof ISafe__factory.connect>,
    );

    const result = await resolveAcceptedInactiveOwners({
      warpRouteId: 'USDT/eclipsemainnet',
      interchainAccount: buildIca(async () => DECLARED_ICA),
      multiProvider: buildMultiProvider(),
      destinations: ['ethereum', 'tron'],
    });

    expect(result).to.deep.equal([{ chain: 'tron', owner: DECLARED_ICA }]);
  });
});
