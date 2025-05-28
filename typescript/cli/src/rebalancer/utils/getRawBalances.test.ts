import { expect } from 'chai';
import sinon from 'sinon';

import { ChainName, Token, TokenStandard } from '@hyperlane-xyz/sdk';

import { MonitorEvent } from '../interfaces/IMonitor.js';

import { getRawBalances } from './getRawBalances.js';

describe('getRawBalances', () => {
  let chains: ChainName[];
  let token: Token;
  let tokenBridgedSupply: bigint;
  let event: MonitorEvent;

  beforeEach(() => {
    chains = ['mainnet'];

    token = {
      chainName: 'mainnet',
      addressOrDenom: '0xAddress',
      isCollateralized: sinon.stub().returns(true),
      standard: TokenStandard.EvmHypCollateral,
    } as unknown as Token;

    tokenBridgedSupply = 100n;

    event = {
      tokensInfo: [
        {
          token,
          bridgedSupply: tokenBridgedSupply,
        },
      ],
    };
  });

  it('should return the bridged supply for the token (EvmHypCollateral)', () => {
    expect(getRawBalances(chains, event)).to.deep.equal({
      mainnet: tokenBridgedSupply,
    });
  });

  it('should return the bridged supply for the token (EvmHypNative)', () => {
    token.standard = TokenStandard.EvmHypNative;

    expect(getRawBalances(chains, event)).to.deep.equal({
      mainnet: tokenBridgedSupply,
    });
  });

  it('should ignore non supported token standards', () => {
    token.standard = TokenStandard.EvmHypOwnerCollateral;

    expect(getRawBalances(chains, event)).to.deep.equal({});
  });

  it('should ignore tokens that are not in the chains list', () => {
    chains = [];

    expect(getRawBalances(chains, event)).to.deep.equal({});
  });

  it('should throw if the bridged supply is undefined', () => {
    delete event.tokensInfo[0].bridgedSupply;

    expect(() => getRawBalances(chains, event)).to.throw(
      'bridgedSupply should not be undefined for collateralized token 0xAddress',
    );
  });
});
