import { expect } from 'chai';
import { pino } from 'pino';
import sinon from 'sinon';

import { type ChainName, type Token, TokenStandard } from '@hyperlane-xyz/sdk';

import { type MonitorEvent } from '../interfaces/IMonitor.js';

import {
  alignLocalToCanonical,
  denormalizeToLocal,
  getRawBalances,
  getTokenScale,
  normalizeConfiguredAmount,
  normalizeToCanonical,
} from './balanceUtils.js';

const testLogger = pino({ level: 'silent' });

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
      confirmedBlockTags: { mainnet: 1000 },
    };
  });

  it('should return the bridged supply for the token (EvmHypCollateral)', () => {
    expect(getRawBalances(chains, event, testLogger)).to.deep.equal({
      mainnet: tokenBridgedSupply,
    });
  });

  it('should normalize bridged supply to canonical units when token has scale', () => {
    token.scale = { numerator: 1, denominator: 1_000_000_000_000 };
    tokenBridgedSupply = 1_000_000_000_000_000_000n;
    event.tokensInfo[0].bridgedSupply = tokenBridgedSupply;

    expect(getRawBalances(chains, event, testLogger)).to.deep.equal({
      mainnet: 1_000_000n,
    });
  });

  it('should return the bridged supply for the token (EvmHypNative)', () => {
    token.standard = TokenStandard.EvmHypNative;

    expect(getRawBalances(chains, event, testLogger)).to.deep.equal({
      mainnet: tokenBridgedSupply,
    });
  });

  it('should ignore non supported token standards', () => {
    token.standard = TokenStandard.EvmHypOwnerCollateral;

    expect(getRawBalances(chains, event, testLogger)).to.deep.equal({});
  });

  it('should ignore tokens that are not in the chains list', () => {
    chains = [];

    expect(getRawBalances(chains, event, testLogger)).to.deep.equal({});
  });

  it('should throw if the bridged supply is undefined', () => {
    delete event.tokensInfo[0].bridgedSupply;

    expect(() => getRawBalances(chains, event, testLogger)).to.throw(
      'bridgedSupply should not be undefined for collateralized token 0xAddress',
    );
  });
});

describe('scale helpers', () => {
  const token = {
    decimals: 18,
    scale: { numerator: 1, denominator: 1_000_000_000_000 },
  } as unknown as Token;

  it('normalizes local amount to canonical amount', () => {
    expect(normalizeToCanonical(1_000_000_000_000_000_000n, token)).to.equal(
      1_000_000n,
    );
  });

  it('denormalizes canonical amount to local amount', () => {
    expect(denormalizeToLocal(1_000_000n, token)).to.equal(
      1_000_000_000_000_000_000n,
    );
  });

  it('aligns local amount to exact canonical progress', () => {
    expect(alignLocalToCanonical(999_999_999_999n, token)).to.deep.equal({
      localAmount: 0n,
      messageAmount: 0n,
    });
    expect(
      alignLocalToCanonical(1_000_000_000_000_500_000n, token),
    ).to.deep.equal({
      localAmount: 1_000_000_000_000_000_000n,
      messageAmount: 1_000_000n,
    });
  });

  it('returns identity scale when scale is undefined', () => {
    expect(getTokenScale({} as Token)).to.deep.equal({
      numerator: 1n,
      denominator: 1n,
    });
  });

  it('normalizes configured amount using token decimals and scale', () => {
    expect(normalizeConfiguredAmount('1', token)).to.equal(1_000_000n);
  });
});
