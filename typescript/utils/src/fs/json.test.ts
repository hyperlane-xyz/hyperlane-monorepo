import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  mergeJson,
  mergeJsonInDir,
  readJson,
  readJsonFromDir,
  tryReadJson,
  writeJson,
  writeJsonToDir,
  writeJsonWithAppendMode,
} from './json.js';

describe('JSON utilities', () => {
  const testDir = path.join(os.tmpdir(), 'hyperlane-json-test');
  const testFile = path.join(testDir, 'test.json');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('readJson', () => {
    it('reads and parses JSON file', () => {
      fs.writeFileSync(testFile, JSON.stringify({ key: 'value' }));
      const result = readJson<{ key: string }>(testFile);
      expect(result).to.deep.equal({ key: 'value' });
    });

    it('handles nested objects', () => {
      const data = { nested: { deep: { value: 42 } } };
      fs.writeFileSync(testFile, JSON.stringify(data));
      const result = readJson<typeof data>(testFile);
      expect(result).to.deep.equal(data);
    });

    it('throws for non-existent file', () => {
      expect(() => readJson('/non/existent/file.json')).to.throw();
    });

    it('throws for invalid JSON', () => {
      fs.writeFileSync(testFile, 'not valid json');
      expect(() => readJson(testFile)).to.throw();
    });
  });

  describe('tryReadJson', () => {
    it('returns parsed JSON on success', () => {
      fs.writeFileSync(testFile, JSON.stringify({ key: 'value' }));
      const result = tryReadJson<{ key: string }>(testFile);
      expect(result).to.deep.equal({ key: 'value' });
    });

    it('returns null for non-existent file', () => {
      const result = tryReadJson('/non/existent/file.json');
      expect(result).to.be.null;
    });

    it('returns null for invalid JSON', () => {
      fs.writeFileSync(testFile, 'not valid json');
      const result = tryReadJson(testFile);
      expect(result).to.be.null;
    });
  });

  describe('writeJson', () => {
    it('writes JSON with formatting and trailing newline', () => {
      writeJson(testFile, { key: 'value' });
      const content = fs.readFileSync(testFile, 'utf8');
      expect(content).to.equal('{\n  "key": "value"\n}\n');
    });

    it('handles arrays', () => {
      writeJson(testFile, [1, 2, 3]);
      const result = readJson<number[]>(testFile);
      expect(result).to.deep.equal([1, 2, 3]);
    });

    it('creates directory if needed', () => {
      const nestedFile = path.join(testDir, 'nested', 'test.json');
      writeJson(nestedFile, { nested: true });
      expect(fs.existsSync(nestedFile)).to.be.true;
    });
  });

  describe('mergeJson', () => {
    it('creates file if it does not exist', () => {
      mergeJson(testFile, { key: 'value' });
      const result = readJson<{ key: string }>(testFile);
      expect(result).to.deep.equal({ key: 'value' });
    });

    it('merges with existing content', () => {
      writeJson(testFile, { existing: 'data', toOverwrite: 'old' });
      mergeJson(testFile, { new: 'data', toOverwrite: 'new' });
      const result = readJson<Record<string, string>>(testFile);
      expect(result).to.deep.equal({
        existing: 'data',
        new: 'data',
        toOverwrite: 'new',
      });
    });
  });

  describe('readJsonFromDir', () => {
    it('reads JSON from directory with filename', () => {
      fs.writeFileSync(
        path.join(testDir, 'config.json'),
        JSON.stringify({ config: true }),
      );
      const result = readJsonFromDir<{ config: boolean }>(
        testDir,
        'config.json',
      );
      expect(result).to.deep.equal({ config: true });
    });
  });

  describe('writeJsonToDir', () => {
    it('writes JSON to directory with filename', () => {
      writeJsonToDir(testDir, 'output.json', { output: true });
      const result = readJson<{ output: boolean }>(
        path.join(testDir, 'output.json'),
      );
      expect(result).to.deep.equal({ output: true });
    });
  });

  describe('mergeJsonInDir', () => {
    it('merges JSON in directory with filename', () => {
      writeJsonToDir(testDir, 'merge.json', { existing: 'data' });
      mergeJsonInDir(testDir, 'merge.json', { new: 'data' });
      const result = readJson<Record<string, string>>(
        path.join(testDir, 'merge.json'),
      );
      expect(result).to.deep.equal({ existing: 'data', new: 'data' });
    });
  });

  describe('writeJsonWithAppendMode', () => {
    it('writes new data when file does not exist (appendMode false)', () => {
      writeJsonWithAppendMode(testFile, { a: 1, b: 2 }, false);
      const result = readJson<Record<string, number>>(testFile);
      expect(result).to.deep.equal({ a: 1, b: 2 });
    });

    it('writes new data when file does not exist (appendMode true)', () => {
      writeJsonWithAppendMode(testFile, { a: 1, b: 2 }, true);
      const result = readJson<Record<string, number>>(testFile);
      expect(result).to.deep.equal({ a: 1, b: 2 });
    });

    it('overwrites when appendMode is false', () => {
      writeJson(testFile, { a: 'old', b: 'old' });
      writeJsonWithAppendMode(testFile, { a: 'new', b: 'new' }, false);
      const result = readJson<Record<string, string>>(testFile);
      expect(result).to.deep.equal({ a: 'new', b: 'new' });
    });

    it('preserves existing values when appendMode is true', () => {
      writeJson(testFile, { a: 'existing', b: 'existing' });
      writeJsonWithAppendMode(testFile, { a: 'new', b: 'new', c: 'new' }, true);
      const result = readJson<Record<string, string>>(testFile);
      expect(result).to.deep.equal({ a: 'existing', b: 'existing', c: 'new' });
    });

    it('preserves existing keys not present in newData when appendMode is true', () => {
      writeJson(testFile, { a: 'existing', b: 'existing', c: 'existing' });
      writeJsonWithAppendMode(testFile, { a: 'new' }, true);
      const result = readJson<Record<string, string>>(testFile);
      // All existing keys should be preserved, 'a' keeps its existing value
      expect(result).to.deep.equal({
        a: 'existing',
        b: 'existing',
        c: 'existing',
      });
    });
  });
});
