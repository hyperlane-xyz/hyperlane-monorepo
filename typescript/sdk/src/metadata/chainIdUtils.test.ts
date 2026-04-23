import { expect } from 'vitest';

import {
  areChainIdsEqual,
  getEffectiveDomainId,
  tryNormalizeNumericChainId,
} from './chainIdUtils.js';

describe(tryNormalizeNumericChainId.name, () => {
  it('accepts safe integer numbers', () => {
    expect(tryNormalizeNumericChainId(0)).toBe(0);
    expect(tryNormalizeNumericChainId(123)).toBe(123);
  });

  it('accepts canonical numeric strings', () => {
    expect(tryNormalizeNumericChainId('0')).toBe(0);
    expect(tryNormalizeNumericChainId('123')).toBe(123);
  });

  it('rejects non-canonical or invalid inputs', () => {
    expect(tryNormalizeNumericChainId('00123')).toBe(null);
    expect(tryNormalizeNumericChainId('cosmoshub-4')).toBe(null);
    expect(tryNormalizeNumericChainId(1.5)).toBe(null);
    expect(tryNormalizeNumericChainId(Number.MAX_SAFE_INTEGER + 1)).toBe(null);
  });
});

describe(areChainIdsEqual.name, () => {
  it('matches exact values and canonical numeric aliases', () => {
    expect(areChainIdsEqual(123, 123)).toBe(true);
    expect(areChainIdsEqual('123', 123)).toBe(true);
  });

  it('rejects nullish and non-matching values', () => {
    expect(areChainIdsEqual(undefined, 123)).toBe(false);
    expect(areChainIdsEqual(null, '123')).toBe(false);
    expect(areChainIdsEqual(5, 10)).toBe(false);
    expect(areChainIdsEqual('5', 10)).toBe(false);
    expect(areChainIdsEqual('00123', 123)).toBe(false);
    expect(areChainIdsEqual('cosmoshub-4', 4)).toBe(false);
  });
});

describe(getEffectiveDomainId.name, () => {
  it('prefers explicit domain ids', () => {
    expect(getEffectiveDomainId({ chainId: 1, domainId: 999 })).toBe(999);
  });

  it('falls back to normalized chain ids when domain id is absent', () => {
    expect(getEffectiveDomainId({ chainId: 123 })).toBe(123);
    expect(getEffectiveDomainId({ chainId: '123' })).toBe(123);
  });

  it('returns null for non-numeric fallback chain ids', () => {
    expect(getEffectiveDomainId({ chainId: 'cosmoshub-4' })).toBe(null);
  });
});
