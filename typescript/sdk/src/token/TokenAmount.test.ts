import { expect } from 'chai';
import { ethers } from 'ethers';

import { TestChainName, test2 } from '../consts/testChains.js';

import { Token } from './Token.js';
import { TokenAmount } from './TokenAmount.js';
import { TokenStandard } from './TokenStandard.js';

const token1 = new Token({
  chainName: TestChainName.test1,
  standard: TokenStandard.ERC20,
  addressOrDenom: ethers.ZeroAddress,
  decimals: 4,
  symbol: 'FAKE',
  name: 'Fake Token',
});
const token2 = Token.FromChainMetadataNativeToken(test2);

describe('TokenAmount', () => {
  let tokenAmount1: TokenAmount;
  let tokenAmount2: TokenAmount;

  it('Constructs', () => {
    tokenAmount1 = new TokenAmount(123456789, token1);
    tokenAmount2 = new TokenAmount('1', token2);
    expect(!!tokenAmount1).to.eq(true);
    expect(!!tokenAmount2).to.eq(true);
  });

  it('Formats human readable string', () => {
    expect(tokenAmount1.getDecimalFormattedAmount()).to.eq(12345.6789);
    expect(tokenAmount2.getDecimalFormattedAmount()).to.eq(1e-18);
  });

  it('Does arithmetic', () => {
    expect(tokenAmount1.plus(1).amount).to.eq(123456790n);
    expect(tokenAmount2.minus(1).amount).to.eq(0n);
  });

  it('Checks equality', () => {
    expect(tokenAmount1.equals(tokenAmount2)).to.be.false;
    expect(tokenAmount1.equals(new TokenAmount(123456789n, token1))).to.true;
  });
});
