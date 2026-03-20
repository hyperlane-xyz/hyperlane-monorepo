import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  mergeYaml,
  readYaml,
  readYamlFromDir,
  tryReadYaml,
  writeYaml,
  yamlParse,
} from './yaml.js';

describe('YAML utilities', () => {
  const testDir = path.join(os.tmpdir(), 'hyperlane-yaml-test');
  const testFile = path.join(testDir, 'test.yaml');

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

  describe('yamlParse', () => {
    it('parses YAML string', () => {
      const result = yamlParse<{ key: string }>('key: value');
      expect(result).to.deep.equal({ key: 'value' });
    });

    it('handles nested structures', () => {
      const yaml = `
nested:
  deep:
    value: 42
`;
      const result = yamlParse<{ nested: { deep: { value: number } } }>(yaml);
      expect(result).to.deep.equal({ nested: { deep: { value: 42 } } });
    });

    it('handles arrays', () => {
      const yaml = `
items:
  - one
  - two
  - three
`;
      const result = yamlParse<{ items: string[] }>(yaml);
      expect(result).to.deep.equal({ items: ['one', 'two', 'three'] });
    });

    it('handles YAML aliases without limit', () => {
      // This tests that maxAliasCount is set to -1, allowing many alias references
      const yaml = `
shared: &shared
  - item1
  - item2
list1: *shared
list2: *shared
list3: *shared
`;
      const result = yamlParse<{
        shared: string[];
        list1: string[];
        list2: string[];
        list3: string[];
      }>(yaml);
      expect(result.list1).to.deep.equal(['item1', 'item2']);
      expect(result.list2).to.deep.equal(['item1', 'item2']);
      expect(result.list3).to.deep.equal(['item1', 'item2']);
    });
  });

  describe('readYaml', () => {
    it('reads and parses YAML file', () => {
      fs.writeFileSync(testFile, 'key: value\n');
      const result = readYaml<{ key: string }>(testFile);
      expect(result).to.deep.equal({ key: 'value' });
    });

    it('throws for non-existent file', () => {
      expect(() => readYaml('/non/existent/file.yaml')).to.throw();
    });
  });

  describe('tryReadYaml', () => {
    it('returns parsed YAML on success', () => {
      fs.writeFileSync(testFile, 'key: value\n');
      const result = tryReadYaml<{ key: string }>(testFile);
      expect(result).to.deep.equal({ key: 'value' });
    });

    it('returns null for non-existent file', () => {
      const result = tryReadYaml('/non/existent/file.yaml');
      expect(result).to.be.null;
    });

    it('returns null for invalid YAML', () => {
      fs.writeFileSync(testFile, 'invalid: yaml: content: [unclosed');
      const result = tryReadYaml(testFile);
      expect(result).to.be.null;
    });
  });

  describe('writeYaml', () => {
    it('writes YAML with trailing newline', () => {
      writeYaml(testFile, { key: 'value' });
      const content = fs.readFileSync(testFile, 'utf8');
      expect(content).to.equal('key: value\n');
    });

    it('sorts map entries', () => {
      writeYaml(testFile, { z: 1, a: 2, m: 3 });
      const content = fs.readFileSync(testFile, 'utf8');
      // Keys should be sorted alphabetically
      expect(content).to.equal('a: 2\nm: 3\nz: 1\n');
    });

    it('handles nested objects', () => {
      writeYaml(testFile, { outer: { inner: 'value' } });
      const result = readYaml<{ outer: { inner: string } }>(testFile);
      expect(result).to.deep.equal({ outer: { inner: 'value' } });
    });

    it('creates directory if needed', () => {
      const nestedFile = path.join(testDir, 'nested', 'test.yaml');
      writeYaml(nestedFile, { nested: true });
      expect(fs.existsSync(nestedFile)).to.be.true;
    });
  });

  describe('mergeYaml', () => {
    it('creates file if it does not exist', () => {
      mergeYaml(testFile, { key: 'value' });
      const result = readYaml<{ key: string }>(testFile);
      expect(result).to.deep.equal({ key: 'value' });
    });

    it('merges with existing content', () => {
      writeYaml(testFile, { existing: 'data', toOverwrite: 'old' });
      mergeYaml(testFile, { new: 'data', toOverwrite: 'new' });
      const result = readYaml<Record<string, string>>(testFile);
      expect(result).to.deep.equal({
        existing: 'data',
        new: 'data',
        toOverwrite: 'new',
      });
    });
  });

  describe('readYamlFromDir', () => {
    it('reads YAML from directory with filename', () => {
      fs.writeFileSync(path.join(testDir, 'config.yaml'), 'config: true\n');
      const result = readYamlFromDir<{ config: boolean }>(
        testDir,
        'config.yaml',
      );
      expect(result).to.deep.equal({ config: true });
    });
  });
});
