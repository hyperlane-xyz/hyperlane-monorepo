import { expect } from 'chai';
import sinon from 'sinon';

import { Token, TokenStandard } from '@hyperlane-xyz/sdk';

import { Config } from '../config/Config.js';
import { MonitorEvent } from '../interfaces/IMonitor.js';

import { getRawBalances } from './getRawBalances.js';

describe('getRawBalances', () => {
  let config: Config;
  let token: Token;
  let tokenBridgedSupply: bigint;
  let event: MonitorEvent;

  beforeEach(() => {
    config = {
      chains: {
        mainnet: {},
      },
    } as unknown as Config;

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
    expect(getRawBalances(config, event)).to.deep.equal({
      mainnet: tokenBridgedSupply,
    });
  });

  it('should return the bridged supply for the token (EvmHypNative)', () => {
    token.standard = TokenStandard.EvmHypNative;

    expect(getRawBalances(config, event)).to.deep.equal({
      mainnet: tokenBridgedSupply,
    });
  });

  it('should ignore non supported token standards', () => {
    token.standard = TokenStandard.EvmHypOwnerCollateral;

    expect(getRawBalances(config, event)).to.deep.equal({});
  });

  it('should ignore tokens that are not in the config', () => {
    delete config.chains.mainnet;

    expect(getRawBalances(config, event)).to.deep.equal({});
  });

  it('should throw if the bridged supply is undefined', () => {
    delete event.tokensInfo[0].bridgedSupply;

    expect(() => getRawBalances(config, event)).to.throw(
      'bridgedSupply should not be undefined for collateralized token 0xAddress',
    );
  });
});
