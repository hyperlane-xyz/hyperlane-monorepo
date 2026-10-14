import { ERC20__factory } from '@hyperlane-xyz/core';
import { expect } from 'chai';
import { BigNumber, Signer, providers, utils } from 'ethers';
import sinon from 'sinon';

import { test1, test2 } from '../../consts/testChains.js';
import { ChainTechnicalStack } from '../../metadata/chainMetadataTypes.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { SeismicSigner } from '../../providers/SeismicSigner.js';

import { EvmTokenAdapter } from './EvmTokenAdapter.js';

/**
 * Covers the signed-read branch of EvmTokenAdapter: on a Seismic chain, when
 * the adapter holds the account's own signer, shielded `balanceOf`/`allowance`
 * reads go through `SeismicSigner.call`; in every other situation the plain
 * (unsigned) contract call is used.
 */
describe('EvmTokenAdapter signed reads on Seismic', () => {
  const TOKEN = '0x57ab1ed011a20000000000000000000000000000';
  const SELF = '0xabbaeCb4698d59f1185321FA2c32710bC5bad9D3';
  const OTHER = '0x1111111111111111111111111111111111111111';
  const SPENDER = '0x2222222222222222222222222222222222222222';
  const BALANCE = 1_000_000n;
  const ALLOWANCE = 5n;

  const seismic = {
    ...test2,
    name: 'seismic',
    technicalStack: ChainTechnicalStack.Seismic,
  };

  let sandbox: sinon.SinonSandbox;
  let signedCall: sinon.SinonStub;
  let unsignedBalanceOf: sinon.SinonStub;
  let unsignedAllowance: sinon.SinonStub;
  let signer: SeismicSigner;

  function adapterFor(
    chainName: string,
    seismicSigners?: Record<string, SeismicSigner>,
  ): EvmTokenAdapter {
    const multiProvider = new MultiProtocolProvider(
      { test1, seismic },
      { seismicSigners },
    );
    return new EvmTokenAdapter(chainName, multiProvider, { token: TOKEN });
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    // Signer that answers signed reads with ABI-encoded results.
    signer = Object.create(SeismicSigner.prototype);
    sandbox.stub(signer, 'getAddress').resolves(SELF);
    const iface = ERC20__factory.createInterface();
    signedCall = sandbox.stub(signer, 'signedCall').callsFake(async (tx) => {
      const { data } = await utils.resolveProperties(tx);
      const selector = utils.hexlify(data ?? '0x').slice(0, 10);
      if (selector === iface.getSighash('balanceOf'))
        return utils.defaultAbiCoder.encode(['uint256'], [BALANCE]);
      if (selector === iface.getSighash('allowance'))
        return utils.defaultAbiCoder.encode(['uint256'], [ALLOWANCE]);
      throw new Error(`unexpected selector ${selector}`);
    });
    // Contract stand-in: real typechain interface/populateTransaction (so the
    // signed path encodes and decodes like production), stubbed unsigned reads
    // so each case can assert the path taken. ethers' own method properties
    // are non-configurable, hence not stubbing a real Contract instance.
    const real = ERC20__factory.connect(
      TOKEN,
      new providers.JsonRpcProvider('http://127.0.0.1:8545'),
    );
    unsignedBalanceOf = sandbox.stub().resolves(BigNumber.from(7));
    unsignedAllowance = sandbox.stub().resolves(BigNumber.from(0));
    sandbox.stub(ERC20__factory, 'connect').returns({
      address: TOKEN,
      interface: real.interface,
      populateTransaction: real.populateTransaction,
      balanceOf: unsignedBalanceOf,
      allowance: unsignedAllowance,
    } as any);
  });

  afterEach(() => sandbox.restore());

  it('does not turn Signer.call into a signed read', () => {
    // ethers routes every view call of a signer-connected Contract through
    // Signer.call; only explicit signedCall() opt-ins may be signed reads.
    expect(SeismicSigner.prototype.call).to.equal(Signer.prototype.call);
  });

  it('reads own balance and allowance via a signed read on Seismic', async () => {
    const adapter = adapterFor('seismic', { seismic: signer });

    expect(await adapter.getBalance(SELF)).to.equal(BALANCE);
    expect(await adapter.isApproveRequired(SELF, SPENDER, 10n)).to.equal(true);
    expect(await adapter.isRevokeApprovalRequired(SELF, SPENDER)).to.equal(
      true,
    );

    expect(signedCall.callCount).to.equal(3);
    expect(signedCall.firstCall.args[0]).to.include({ to: TOKEN });
    expect(unsignedBalanceOf.called).to.equal(false);
    expect(unsignedAllowance.called).to.equal(false);
  });

  it('uses unsigned reads for other accounts even with a signer', async () => {
    const adapter = adapterFor('seismic', { seismic: signer });
    expect(await adapter.getBalance(OTHER)).to.equal(7n);
    expect(await adapter.isApproveRequired(OTHER, SPENDER, 10n)).to.equal(true);
    expect(signedCall.called).to.equal(false);
  });

  it('uses unsigned reads on Seismic without a signer', async () => {
    const adapter = adapterFor('seismic');
    expect(await adapter.getBalance(SELF)).to.equal(7n);
    expect(signedCall.called).to.equal(false);
    expect(unsignedBalanceOf.calledOnce).to.equal(true);
  });

  it('uses unsigned reads on non-Seismic chains even with a signer configured', async () => {
    const adapter = adapterFor('test1', { test1: signer });
    expect(await adapter.getBalance(SELF)).to.equal(7n);
    expect(signedCall.called).to.equal(false);
  });
});
