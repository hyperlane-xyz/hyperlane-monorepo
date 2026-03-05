import {
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypXERC20Lockbox__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { expect } from 'chai';
import sinon from 'sinon';

import { testChainMetadata } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { stubMultiProtocolProvider } from '../../test/multiProviderStubs.js';

import { EvmHypXERC20LockboxAdapter } from './EvmTokenAdapter.js';

describe('EvmHypXERC20LockboxAdapter', () => {
  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProtocolProvider;

  const chainName = 'test1';
  const hypTokenAddress = '0x1111111111111111111111111111111111111111';
  const wrappedTokenAddress = '0x2222222222222222222222222222222222222222';

  beforeEach(() => {
    multiProvider = new MultiProtocolProvider(testChainMetadata);
    sandbox = stubMultiProtocolProvider(multiProvider);

    sandbox.stub(HypERC20__factory, 'connect').returns({} as any);
    sandbox.stub(TokenRouter__factory, 'connect').returns({} as any);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('loads wrapped token from lockbox contract', async () => {
    const collateralWrappedToken = sandbox
      .stub()
      .rejects(new Error('collateral wrappedToken should not be called'));
    sandbox.stub(HypERC20Collateral__factory, 'connect').returns({
      wrappedToken: collateralWrappedToken,
    } as any);

    const lockboxWrappedToken = sandbox.stub().resolves(wrappedTokenAddress);
    sandbox.stub(HypXERC20Lockbox__factory, 'connect').returns({
      wrappedToken: lockboxWrappedToken,
      lockbox: sandbox
        .stub()
        .resolves('0x3333333333333333333333333333333333333333'),
      xERC20: sandbox
        .stub()
        .resolves('0x4444444444444444444444444444444444444444'),
    } as any);

    const adapter = new EvmHypXERC20LockboxAdapter(chainName, multiProvider, {
      token: hypTokenAddress,
    });
    const wrapped = await adapter.getWrappedTokenAddress();

    expect(wrapped).to.equal(wrappedTokenAddress);
    expect(lockboxWrappedToken.calledOnce).to.equal(true);
    expect(collateralWrappedToken.called).to.equal(false);
  });
});
