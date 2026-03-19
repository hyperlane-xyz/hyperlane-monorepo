import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
  remoteDecimalsToScale,
  scaleToRemoteDecimals,
} from '../warp/warp-tx.js';

describe('scaleToRemoteDecimals', () => {
  const valid = [
    { localDecimals: 9, scale: undefined, expected: 9 },
    { localDecimals: 6, scale: undefined, expected: 6 },
    { localDecimals: 9, scale: 1, expected: 9 },
    // upscale
    { localDecimals: 9, scale: 1e9, expected: 18 },
    { localDecimals: 6, scale: 1e6, expected: 12 },
    { localDecimals: 5, scale: 10, expected: 6 },
    // downscale
    { localDecimals: 9, scale: 0.0001, expected: 5 },
    { localDecimals: 9, scale: 0.1, expected: 8 },
    { localDecimals: 6, scale: 0.001, expected: 3 },
  ];

  for (const { localDecimals, scale, expected } of valid) {
    it(`(${localDecimals}, ${scale}) => ${expected}`, () => {
      expect(scaleToRemoteDecimals(localDecimals, scale)).to.equal(expected);
    });
  }

  const invalid = [
    { localDecimals: 9, scale: 3, error: /power of 10/ },
    { localDecimals: 9, scale: 0, error: /positive/ },
    { localDecimals: 9, scale: -100, error: /positive/ },
    { localDecimals: 2, scale: 0.0001, error: /negative remoteDecimals/ },
  ];

  for (const { localDecimals, scale, error } of invalid) {
    it(`(${localDecimals}, ${scale}) throws ${error}`, () => {
      expect(() => scaleToRemoteDecimals(localDecimals, scale)).to.throw(error);
    });
  }
});

describe('remoteDecimalsToScale', () => {
  const cases = [
    { localDecimals: 9, remoteDecimals: 9, expected: undefined },
    { localDecimals: 9, remoteDecimals: 18, expected: 1e9 },
    { localDecimals: 9, remoteDecimals: 5, expected: 0.0001 },
    { localDecimals: 6, remoteDecimals: 3, expected: 0.001 },
  ];

  for (const { localDecimals, remoteDecimals, expected } of cases) {
    it(`(${localDecimals}, ${remoteDecimals}) => ${expected}`, () => {
      expect(remoteDecimalsToScale(localDecimals, remoteDecimals)).to.equal(
        expected,
      );
    });
  }
});

describe('scale round-trip', () => {
  const cases = [
    { localDecimals: 9, remoteDecimals: 18 },
    { localDecimals: 9, remoteDecimals: 9 },
    { localDecimals: 9, remoteDecimals: 5 },
    { localDecimals: 6, remoteDecimals: 3 },
    { localDecimals: 6, remoteDecimals: 12 },
    { localDecimals: 8, remoteDecimals: 8 },
    { localDecimals: 5, remoteDecimals: 6 },
  ];

  for (const { localDecimals, remoteDecimals } of cases) {
    it(`local=${localDecimals} remote=${remoteDecimals}`, () => {
      const scale = remoteDecimalsToScale(localDecimals, remoteDecimals);
      expect(scaleToRemoteDecimals(localDecimals, scale)).to.equal(
        remoteDecimals,
      );
    });
  }
});
