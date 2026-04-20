import { expect } from 'chai';

import {
  areChainIdsEqual,
  getEffectiveDomainId,
  tryNormalizeNumericChainId,
} from './chainIdUtils.js';

describe(tryNormalizeNumericChainId.name, () => {
  it('accepts safe integer numbers', () => {
    expect(tryNormalizeNumericChainId(0)).to.equal(0);
    expect(tryNormalizeNumericChainId(123)).to.equal(123);
  });

  it('accepts canonical numeric strings', () => {
    expect(tryNormalizeNumericChainId('0')).to.equal(0);
    expect(tryNormalizeNumericChainId('123')).to.equal(123);
  });

  it('rejects non-canonical or invalid inputs', () => {
    expect(tryNormalizeNumericChainId('00123')).to.equal(null);
    expect(tryNormalizeNumericChainId('cosmoshub-4')).to.equal(null);
    expect(tryNormalizeNumericChainId(1.5)).to.equal(null);
    expect(tryNormalizeNumericChainId(Number.MAX_SAFE_INTEGER + 1)).to.equal(
      null,
    );
  });
});

describe(areChainIdsEqual.name, () => {
  it('matches exact values and canonical numeric aliases', () => {
    expect(areChainIdsEqual(123, 123)).to.equal(true);
    expect(areChainIdsEqual('123', 123)).to.equal(true);
  });

  it('rejects nullish and non-matching values', () => {
    expect(areChainIdsEqual(undefined, 123)).to.equal(false);
    expect(areChainIdsEqual(null, '123')).to.equal(false);
    expect(areChainIdsEqual(5, 10)).to.equal(false);
    expect(areChainIdsEqual('5', 10)).to.equal(false);
    expect(areChainIdsEqual('00123', 123)).to.equal(false);
    expect(areChainIdsEqual('cosmoshub-4', 4)).to.equal(false);
  });
});

describe(getEffectiveDomainId.name, () => {
  it('prefers explicit domain ids', () => {
    expect(getEffectiveDomainId({ chainId: 1, domainId: 999 })).to.equal(999);
  });

  it('falls back to normalized chain ids when domain id is absent', () => {
    expect(getEffectiveDomainId({ chainId: 123 })).to.equal(123);
    expect(getEffectiveDomainId({ chainId: '123' })).to.equal(123);
  });

  it('returns null for non-numeric fallback chain ids', () => {
    expect(getEffectiveDomainId({ chainId: 'cosmoshub-4' })).to.equal(null);
  });
});
