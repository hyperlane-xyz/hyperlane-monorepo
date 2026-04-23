import { expect } from 'vitest';

import { isHttpsUrl, isRelativeUrl, isUrl } from './url.js';

describe('URL Utilities', () => {
  it('isUrl', () => {
    expect(isUrl(undefined)).toBe(false);
    expect(isUrl(null)).toBe(false);
    expect(isUrl('')).toBe(false);
    expect(isUrl('foobar')).toBe(false);
    expect(isUrl('https://hyperlane.xyz')).toBe(true);
  });

  it('isHttpsUrl', () => {
    expect(isHttpsUrl(undefined)).toBe(false);
    expect(isHttpsUrl(null)).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
    expect(isHttpsUrl('foobar')).toBe(false);
    expect(isHttpsUrl('http://hyperlane.xyz')).toBe(false);
    expect(isHttpsUrl('https://hyperlane.xyz')).toBe(true);
  });

  it('isRelativeUrl', () => {
    expect(isRelativeUrl(undefined)).toBe(false);
    expect(isRelativeUrl(null)).toBe(false);
    expect(isRelativeUrl('')).toBe(false);
    expect(isRelativeUrl('foobar')).toBe(false);
    expect(isRelativeUrl('https://hyperlane.xyz')).toBe(false);
    expect(isRelativeUrl('/foobar')).toBe(true);
    expect(isRelativeUrl('/foo/bar', 'https://hyperlane.xyz')).toBe(true);
  });
});
