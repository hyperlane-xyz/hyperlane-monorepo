import { expect } from 'chai';

import { HookConfigSchema, HookType } from './types.js';

const ADDRESS = '0x0000000000000000000000000000000000000001';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const igpConfig = (feeToken: string, remote = 'test1') => ({
  type: HookType.INTERCHAIN_GAS_PAYMASTER,
  owner: ADDRESS,
  beneficiary: ADDRESS,
  oracleKey: ADDRESS,
  overhead: {},
  oracleConfig: {},
  tokenOracleConfig: {
    [feeToken]: {
      [remote]: {
        tokenExchangeRate: '1',
        gasPrice: '1',
      },
    },
  },
});

describe('IgpSchema tokenOracleConfig', () => {
  it('allows non-zero EVM fee-token keys and chain-name remote keys', () => {
    expect(HookConfigSchema.safeParse(igpConfig(ADDRESS)).success).to.be.true;
  });

  it('rejects zero-address fee-token keys', () => {
    expect(HookConfigSchema.safeParse(igpConfig(ZERO_ADDRESS)).success).to.be
      .false;
  });

  it('rejects non-address fee-token keys', () => {
    expect(HookConfigSchema.safeParse(igpConfig('NATIVE_TOKEN')).success).to.be
      .false;
  });

  it('rejects invalid remote chain keys', () => {
    expect(
      HookConfigSchema.safeParse(igpConfig(ADDRESS, 'not-a-chain')).success,
    ).to.be.false;
  });
});
