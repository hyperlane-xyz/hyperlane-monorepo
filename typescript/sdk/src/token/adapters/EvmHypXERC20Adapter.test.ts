import { expect } from 'chai';
import sinon from 'sinon';

import { test1 } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import { EvmHypXERC20Adapter, EvmTokenAdapter } from './EvmTokenAdapter.js';

describe('EvmHypXERC20Adapter approvals', () => {
  const ROUTER = '0x099DCfC4e3b41dbdF44463f3cFcf91EfF41Cc0FE';
  const WRAPPER = '0x2222222222222222222222222222222222222222';
  const OWNER = '0xabbaeCb4698d59f1185321FA2c32710bC5bad9D3';

  let adapter: EvmHypXERC20Adapter;
  let sandbox: sinon.SinonSandbox;
  let allowanceRead: sinon.SinonStub;

  function stubPredicateWrapper(address: string | null) {
    sandbox.stub(adapter, 'getPredicateWrapperAddress').resolves(address);
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    const multiProvider =
      MultiProtocolProvider.createTestMultiProtocolProvider();
    adapter = new EvmHypXERC20Adapter(test1.name, multiProvider, {
      token: ROUTER,
    });
    // The wrapped-token adapter is what reads `allowance` on chain; make it
    // observable and deterministic (allowance 0 => approve/revoke would be required).
    allowanceRead = sandbox
      .stub(EvmTokenAdapter.prototype, 'isApproveRequired')
      .resolves(true);
    sandbox
      .stub(EvmTokenAdapter.prototype, 'isRevokeApprovalRequired')
      .resolves(true);
    // @ts-ignore access protected member for the unit test
    sandbox.stub(adapter, 'getWrappedTokenAddress').resolves(WRAPPER);
  });

  afterEach(() => sandbox.restore());

  it('needs no approval when the router burns from the sender directly', async () => {
    stubPredicateWrapper(null);
    expect(await adapter.isApproveRequired(OWNER, ROUTER, 1n)).to.equal(false);
    expect(await adapter.isRevokeApprovalRequired(OWNER, ROUTER)).to.equal(
      false,
    );
    // No allowance read was issued against the xERC20 token.
    expect(allowanceRead.called).to.equal(false);
  });

  it('keeps the inherited approval flow when a Predicate wrapper pulls the tokens', async () => {
    stubPredicateWrapper(WRAPPER);
    expect(await adapter.isApproveRequired(OWNER, ROUTER, 1n)).to.equal(true);
    expect(await adapter.isRevokeApprovalRequired(OWNER, ROUTER)).to.equal(
      true,
    );
    expect(allowanceRead.calledOnce).to.equal(true);
  });

  it('keeps the inherited approval flow for spenders other than the router', async () => {
    stubPredicateWrapper(null);
    const otherSpender = '0x3333333333333333333333333333333333333333';
    expect(await adapter.isApproveRequired(OWNER, otherSpender, 1n)).to.equal(
      true,
    );
    expect(allowanceRead.calledOnce).to.equal(true);
  });
});
