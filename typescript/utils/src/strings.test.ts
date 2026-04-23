import { Readable } from 'stream';
import { expect } from 'vitest';

import {
  errorToString,
  fromHexString,
  sanitizeString,
  streamToString,
  toHexString,
  toTitleCase,
  trimToLength,
} from './strings.js';

describe('String Utilities', () => {
  it('should convert string to title case', () => {
    expect(toTitleCase('hello world')).toBe('Hello World');
    expect(toTitleCase('HELLO WORLD')).toBe('Hello World');
    expect(toTitleCase('4ELLO WORLD')).toBe('4ello World');
    expect(toTitleCase('')).toBe('');
  });

  it('should sanitize string by removing non-alphanumeric characters', () => {
    expect(sanitizeString('Hello, World!')).toBe('helloworld');
    expect(sanitizeString('123-456')).toBe('123456');
    expect(sanitizeString('')).toBe('');
  });

  it('should trim string to specified length', () => {
    expect(trimToLength('Hello, World!', 5)).toBe('Hello...');
    expect(trimToLength('Short', 10)).toBe('Short');
    expect(trimToLength('', 10)).toBe('');
  });

  it('should convert stream to string', async () => {
    const stream = new Readable();
    stream.push('Hello, ');
    stream.push('World!');
    stream.push(null);

    const result = await streamToString(stream);
    expect(result).toBe('Hello, World!');
  });

  it('should convert error to string', () => {
    expect(errorToString('Error message')).toBe('Error message');
    expect(errorToString({ message: 'Error object' })).toBe('Error object');
    expect(errorToString(404)).toBe('Error code: 404');
    expect(errorToString(null)).toBe('Unknown Error');
  });

  it('should convert hex string to buffer and back', () => {
    const hexString = '0x48656c6c6f';
    const buffer = fromHexString(hexString);
    expect(buffer.toString('utf8')).toBe('Hello');
    expect(toHexString(buffer)).toBe(hexString);
  });
});
