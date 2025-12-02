import { expect } from 'chai';
import { Readable } from 'stream';

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
    expect(toTitleCase('hello world')).to.equal('Hello World');
    expect(toTitleCase('HELLO WORLD')).to.equal('Hello World');
    expect(toTitleCase('4ELLO WORLD')).to.equal('4ello World');
    expect(toTitleCase('')).to.equal('');
  });

  it('should sanitize string by removing non-alphanumeric characters', () => {
    expect(sanitizeString('Hello, World!')).to.equal('helloworld');
    expect(sanitizeString('123-456')).to.equal('123456');
    expect(sanitizeString('')).to.equal('');
  });

  it('should trim string to specified length', () => {
    expect(trimToLength('Hello, World!', 5)).to.equal('Hello...');
    expect(trimToLength('Short', 10)).to.equal('Short');
    expect(trimToLength('', 10)).to.equal('');
  });

  it('should convert stream to string', async () => {
    const stream = new Readable();
    stream.push('Hello, ');
    stream.push('World!');
    stream.push(null);

    const result = await streamToString(stream);
    expect(result).to.equal('Hello, World!');
  });

  it('should convert error to string', () => {
    expect(errorToString('Error message')).to.equal('Error message');
    expect(errorToString({ message: 'Error object' })).to.equal('Error object');
    expect(errorToString(404)).to.equal('Error code: 404');
    expect(errorToString(null)).to.equal('Unknown Error');
  });

  it('should convert hex string to buffer and back', () => {
    const hexString = '0x48656c6c6f';
    const buffer = fromHexString(hexString);
    expect(buffer.toString('utf8')).to.equal('Hello');
    expect(toHexString(buffer)).to.equal(hexString);
  });
});
