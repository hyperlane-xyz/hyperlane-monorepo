import { type SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';
import hre from 'hardhat';

import {
  ERC20Test__factory,
  type OffchainQuotedPiecewiseLinearFee,
  OffchainQuotedPiecewiseLinearFee__factory,
} from '@hyperlane-xyz/core';
import {
  WARP_QUOTE_AMOUNT_WILDCARD,
  WARP_TARGET_ROUTER_NONE,
  WILDCARD_BYTES32,
} from '@hyperlane-xyz/provider-sdk/quote';

import { EvmPrivateKeyQuoteSigner } from './EvmPrivateKeyQuoteSigner.js';
import {
  type CreateEvmPiecewiseWarpQuoteRequest,
  type EvmPiecewiseStandingCurve,
} from './EvmPiecewiseQuote.js';
import { EvmPiecewiseQuoteWriter } from './EvmPiecewiseQuoteWriter.js';

chai.use(chaiAsPromised);
const { expect } = chai;

// Anvil / hardhat default test mnemonic — public, no live funds.
const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';
const DESTINATION = 42161;
const RECIPIENT = WILDCARD_BYTES32;

const CURVE: EvmPiecewiseStandingCurve = {
  breakpoints: [250_000n, 750_000n],
  marginalBpsX1e4: [40_000, 100_000, 200_000],
  staleAfterSeconds: 60,
  staleMarginalSurchargeBpsX1e4: [10_000, 20_000, 30_000],
};

describe('EvmPiecewiseQuoteWriter (hardhat)', () => {
  let owner: SignerWithAddress;
  let fee: OffchainQuotedPiecewiseLinearFee;
  let quoteSignerWallet: Wallet;

  before(async () => {
    [owner] = await hre.ethers.getSigners();
    const token = await new ERC20Test__factory(owner).deploy(
      'fake',
      'FAKE',
      '100000000000000000000',
      6,
    );
    await token.deployed();

    quoteSignerWallet = Wallet.fromMnemonic(TEST_MNEMONIC, "m/44'/60'/0'/0/1");
    fee = await new OffchainQuotedPiecewiseLinearFee__factory(owner).deploy(
      quoteSignerWallet.address,
      token.address,
      [250_000n, 750_000n],
      [40_000, 100_000, 200_000],
      3,
      owner.address,
    );
    await fee.deployed();
  });

  function makeWriter(privateKey: string = quoteSignerWallet.privateKey) {
    return new EvmPiecewiseQuoteWriter(
      owner,
      new EvmPrivateKeyQuoteSigner(privateKey),
      fee.address,
    );
  }

  async function nowSec(): Promise<number> {
    return (await hre.ethers.provider.getBlock('latest')).timestamp;
  }

  async function request(
    destination: number = DESTINATION,
  ): Promise<CreateEvmPiecewiseWarpQuoteRequest> {
    const issuedAt = await nowSec();
    return {
      scope: {
        destination,
        recipient: RECIPIENT,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      curve: CURVE,
      issuedAt,
      expiry: issuedAt + 3_600,
    };
  }

  it('submits, confirms, and reads back a raw standing curve', async () => {
    const writer = makeWriter();
    const req = await request();
    const submitted = await writer.submitQuote(req);

    expect(submitted.txHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(submitted.signature).to.match(/^0x[0-9a-f]+$/);
    expect(submitted.standingStored).to.equal(true);

    const stored = await writer.readStandingCurve(DESTINATION, RECIPIENT);
    expect(stored).to.deep.equal({
      exists: true,
      ...CURVE,
      issuedAt: req.issuedAt,
      expiry: req.expiry,
    });
  });

  it('returns an explicit empty stored-curve result for an unused scope', async () => {
    const stored = await makeWriter().readStandingCurve(99_999, RECIPIENT);
    expect(stored).to.deep.equal({
      exists: false,
      breakpoints: [],
      marginalBpsX1e4: [],
      staleAfterSeconds: 0,
      staleMarginalSurchargeBpsX1e4: [],
      issuedAt: 0,
      expiry: 0,
    });
  });

  it('reports an equal-issuedAt resubmission as a stored-curve no-op', async () => {
    const writer = makeWriter();
    const req = await request(42_162);
    expect((await writer.submitQuote(req)).standingStored).to.equal(true);
    expect((await writer.submitQuote(req)).standingStored).to.equal(false);
  });

  it('rejects an unauthorized quote signer before signing or submitting', async () => {
    const otherWallet = Wallet.fromMnemonic(TEST_MNEMONIC, "m/44'/60'/0'/0/9");
    await expect(
      makeWriter(otherWallet.privateKey).submitQuote(await request(1)),
    ).to.be.rejectedWith(/not authorized/);
  });

  it('rejects curves larger than the deployed maxBands', async () => {
    const req = await request(2);
    req.curve = {
      breakpoints: [1n, 2n, 3n],
      marginalBpsX1e4: [1, 2, 3, 4],
      staleAfterSeconds: 60,
      staleMarginalSurchargeBpsX1e4: [0, 0, 0, 0],
    };
    await expect(makeWriter().submitQuote(req)).to.be.rejectedWith(
      /4 bands but maxBands is 3/,
    );
  });

  it('rejects non-standing requests and stale thresholds after expiry', async () => {
    const transient = await request(3);
    transient.expiry = transient.issuedAt;
    await expect(makeWriter().submitQuote(transient)).to.be.rejectedWith(
      /must be standing quotes/,
    );

    const staleAfterExpiry = await request(4);
    staleAfterExpiry.curve = { ...CURVE, staleAfterSeconds: 3_601 };
    await expect(makeWriter().submitQuote(staleAfterExpiry)).to.be.rejectedWith(
      /no later than expiry/,
    );
  });
});
