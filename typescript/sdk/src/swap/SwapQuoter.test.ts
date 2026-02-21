import { expect } from 'chai';
import { BigNumber, constants } from 'ethers';

import { parseBridgeQuoteTransferRemoteQuotes } from './SwapQuoter.js';

describe('SwapQuoter', () => {
  const TOKEN_A = '0x1111111111111111111111111111111111111111';
  const TOKEN_B = '0x2222222222222222222222222222222222222222';

  it('parses canonical quote ordering', () => {
    const parsed = parseBridgeQuoteTransferRemoteQuotes(
      [
        { token: constants.AddressZero, amount: BigNumber.from(15) },
        { token: TOKEN_A, amount: BigNumber.from(1012) },
      ],
      BigNumber.from(1000),
      TOKEN_A,
    );

    expect(parsed.fee.toString()).to.equal('15');
    expect(parsed.feeToken).to.equal(constants.AddressZero);
    expect(parsed.tokenPull.toString()).to.equal('1012');
    expect(parsed.tokenPullToken).to.equal(TOKEN_A);
    expect(parsed.bridgeTokenFee.toString()).to.equal('12');
  });

  it('parses non-canonical ordering by selecting largest token pull', () => {
    const parsed = parseBridgeQuoteTransferRemoteQuotes(
      [
        { token: TOKEN_A, amount: BigNumber.from(1002) },
        { token: constants.AddressZero, amount: BigNumber.from(3) },
        { token: TOKEN_B, amount: BigNumber.from(1021) },
      ],
      BigNumber.from(1000),
    );

    expect(parsed.fee.toString()).to.equal('3');
    expect(parsed.tokenPull.toString()).to.equal('1021');
    expect(parsed.tokenPullToken).to.equal(TOKEN_B);
    expect(parsed.bridgeTokenFee.toString()).to.equal('21');
  });

  it('aggregates multiple native fee quotes', () => {
    const parsed = parseBridgeQuoteTransferRemoteQuotes(
      [
        { token: constants.AddressZero, amount: BigNumber.from(3) },
        { token: TOKEN_A, amount: BigNumber.from(1002) },
        { token: constants.AddressZero, amount: BigNumber.from(7) },
      ],
      BigNumber.from(1000),
      TOKEN_A,
    );

    expect(parsed.fee.toString()).to.equal('10');
    expect(parsed.feeToken).to.equal(constants.AddressZero);
    expect(parsed.tokenPull.toString()).to.equal('1002');
    expect(parsed.tokenPullToken).to.equal(TOKEN_A);
    expect(parsed.bridgeTokenFee.toString()).to.equal('2');
  });

  it('uses the requested bridge token quote when provided', () => {
    const parsed = parseBridgeQuoteTransferRemoteQuotes(
      [
        { token: constants.AddressZero, amount: BigNumber.from(5) },
        { token: TOKEN_A, amount: BigNumber.from(1007) },
        { token: TOKEN_B, amount: BigNumber.from(2500) },
      ],
      BigNumber.from(1000),
      TOKEN_A,
    );

    expect(parsed.tokenPull.toString()).to.equal('1007');
    expect(parsed.tokenPullToken).to.equal(TOKEN_A);
    expect(parsed.bridgeTokenFee.toString()).to.equal('7');
  });

  it('aggregates duplicate token quotes before selecting a token pull', () => {
    const parsed = parseBridgeQuoteTransferRemoteQuotes(
      [
        { token: TOKEN_A, amount: BigNumber.from(600) },
        { token: TOKEN_B, amount: BigNumber.from(1000) },
        { token: TOKEN_A, amount: BigNumber.from(450) },
      ],
      BigNumber.from(1000),
      TOKEN_A,
    );

    expect(parsed.tokenPull.toString()).to.equal('1050');
    expect(parsed.tokenPullToken).to.equal(TOKEN_A);
    expect(parsed.bridgeTokenFee.toString()).to.equal('50');
  });

  it('returns zero fees when no native or token quote is available', () => {
    const parsed = parseBridgeQuoteTransferRemoteQuotes(
      [],
      BigNumber.from(1000),
    );

    expect(parsed.fee.toString()).to.equal('0');
    expect(parsed.feeToken).to.equal(constants.AddressZero);
    expect(parsed.tokenPull.toString()).to.equal('0');
    expect(parsed.tokenPullToken).to.equal(constants.AddressZero);
    expect(parsed.bridgeTokenFee.toString()).to.equal('0');
  });
});
