import { expect } from 'chai';
import sinon from 'sinon';

import { TokenRouter__factory } from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress } from '../test/testUtils.js';

import {
  EvmWarpRouteReader,
  TOKEN_FEE_CONTRACT_VERSION,
} from './EvmWarpRouteReader.js';

describe('EvmWarpRouteReader', () => {
  let sandbox: sinon.SinonSandbox;
  let evmWarpRouteReader: EvmWarpRouteReader;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    evmWarpRouteReader = new EvmWarpRouteReader(
      MultiProvider.createTestMultiProvider(),
      TestChainName.test1,
    );
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('retries token router domains when a shared domains promise fails', async () => {
    const routerAddress = randomAddress();
    const feeRecipient = randomAddress();
    const routingDestinations = [1, 2];
    const derivedTokenFeeConfig = { address: feeRecipient } as any;
    const domains = sandbox.stub().resolves(routingDestinations);

    sandbox.stub(TokenRouter__factory, 'connect').returns({
      feeRecipient: sandbox.stub().resolves(feeRecipient),
      domains,
    } as any);
    sandbox
      .stub(evmWarpRouteReader, 'fetchPackageVersion')
      .resolves(TOKEN_FEE_CONTRACT_VERSION);
    const deriveTokenFeeConfigStub = sandbox
      .stub(evmWarpRouteReader.evmTokenFeeReader, 'deriveTokenFeeConfig')
      .resolves(derivedTokenFeeConfig);

    const tokenFee = await evmWarpRouteReader.fetchTokenFee(
      routerAddress,
      undefined,
      () => Promise.reject(new Error('transient domains failure')),
    );

    expect(tokenFee).to.equal(derivedTokenFeeConfig);
    expect(domains.calledOnce).to.equal(true);
    expect(
      deriveTokenFeeConfigStub.calledOnceWithExactly({
        address: feeRecipient,
        routingDestinations,
      }),
    ).to.equal(true);
  });

  it('does not start shared domains reads when token fee derivation returns early', async () => {
    const routerAddress = randomAddress();
    let getDestinationsCalls = 0;

    sandbox.stub(TokenRouter__factory, 'connect').returns({
      feeRecipient: sandbox.stub().resolves(randomAddress()),
      domains: sandbox.stub().resolves([1, 2]),
    } as any);
    sandbox.stub(evmWarpRouteReader, 'fetchPackageVersion').resolves('9.9.9');

    const tokenFee = await evmWarpRouteReader.fetchTokenFee(
      routerAddress,
      undefined,
      () => {
        getDestinationsCalls += 1;
        return Promise.resolve([1, 2]);
      },
    );

    expect(tokenFee).to.be.undefined;
    expect(getDestinationsCalls).to.equal(0);
  });
});
