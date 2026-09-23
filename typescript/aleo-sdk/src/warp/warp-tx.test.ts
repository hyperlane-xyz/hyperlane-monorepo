import { expect } from 'chai';

import { getCreateSyntheticTokenTx, scaleToRemoteDecimals } from './warp-tx.js';

describe('Aleo synthetic deployment decimals', () => {
  for (const { decimals, scale, remote } of [
    { decimals: 9, scale: undefined, remote: 9 },
    { decimals: 6, scale: 1, remote: 6 },
    { decimals: 9, scale: 1e9, remote: 18 },
    { decimals: 18, scale: 1e-12, remote: 6 },
    { decimals: 9, scale: 1e-4, remote: 5 },
    { decimals: 0, scale: 1e18, remote: 18 },
    { decimals: 18, scale: 1e-18, remote: 0 },
  ]) {
    it(`initializes local=${decimals}, remote=${remote} for scale=${scale}`, () => {
      const tx = getCreateSyntheticTokenTx(
        'hyp_warp_token_test_v2.aleo',
        'Test',
        'TEST',
        decimals,
        scaleToRemoteDecimals(decimals, scale),
      );
      expect(tx.inputs.slice(-2)).to.deep.equal([
        `${decimals}u8`,
        `${remote}u8`,
      ]);
    });
  }

  it('preserves unscaled initialization for existing callers', () => {
    const tx = getCreateSyntheticTokenTx(
      'hyp_warp_token_test.aleo',
      'Test',
      'TEST',
      6,
    );
    expect(tx.inputs.slice(-2)).to.deep.equal(['6u8', '6u8']);
  });

  for (const scale of [0, -10, 3, 0.3, 0.11, NaN, Infinity]) {
    it(`rejects invalid scale ${scale}`, () => {
      expect(() => scaleToRemoteDecimals(9, scale)).to.throw('power of 10');
    });
  }

  for (const { decimals, scale } of [
    { decimals: 9, scale: 1e19 },
    { decimals: 20, scale: 1e-19 },
    { decimals: 2, scale: 1e-3 },
    { decimals: 255, scale: 10 },
    { decimals: -1, scale: 1 },
    { decimals: 256, scale: 1 },
    { decimals: 1.5, scale: 1 },
  ]) {
    it(`rejects unsupported decimals=${decimals}, scale=${scale}`, () => {
      expect(() => scaleToRemoteDecimals(decimals, scale)).to.throw();
    });
  }
});
