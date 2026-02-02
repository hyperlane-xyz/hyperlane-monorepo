import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  indentYamlOrJson,
  mergeYamlOrJson,
  readYamlOrJson,
  resolveFileFormat,
  writeYamlOrJson,
} from './format.js';

describe('Format utilities', () => {
  const testDir = path.join(os.tmpdir(), 'hyperlane-format-test');

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

  describe('resolveFileFormat', () => {
    it('returns json for .json extension', () => {
      expect(resolveFileFormat('file.json')).to.equal('json');
    });

    it('returns yaml for .yaml extension', () => {
      expect(resolveFileFormat('file.yaml')).to.equal('yaml');
    });

    it('returns yaml for .yml extension', () => {
      expect(resolveFileFormat('file.yml')).to.equal('yaml');
    });

    it('returns undefined for unknown extension', () => {
      expect(resolveFileFormat('file.txt')).to.be.undefined;
    });

    it('format and extension both considered (format checked first for yaml, extension for json)', () => {
      // The logic checks format === 'json' OR extension .json first
      // Then format === 'yaml' OR extension .yaml/.yml
      // So json format/extension takes precedence
      expect(resolveFileFormat('file.txt', 'yaml')).to.equal('yaml');
      expect(resolveFileFormat('file.txt', 'json')).to.equal('json');
      expect(resolveFileFormat('file.json', 'yaml')).to.equal('json'); // .json extension wins
      expect(resolveFileFormat('file.yaml', 'json')).to.equal('json'); // json format wins
    });

    it('returns format when filepath is undefined', () => {
      expect(resolveFileFormat(undefined, 'json')).to.equal('json');
      expect(resolveFileFormat(undefined, 'yaml')).to.equal('yaml');
    });

    it('returns undefined when both are undefined', () => {
      expect(resolveFileFormat(undefined, undefined)).to.be.undefined;
    });
  });

  describe('indentYamlOrJson', () => {
    it('indents single line', () => {
      expect(indentYamlOrJson('line', 2)).to.equal('  line');
    });

    it('indents multiple lines', () => {
      const input = 'line1\nline2\nline3';
      const expected = '    line1\n    line2\n    line3';
      expect(indentYamlOrJson(input, 4)).to.equal(expected);
    });

    it('handles zero indent', () => {
      expect(indentYamlOrJson('line', 0)).to.equal('line');
    });
  });

  describe('readYamlOrJson', () => {
    it('reads JSON file based on extension', () => {
      const jsonFile = path.join(testDir, 'test.json');
      fs.writeFileSync(jsonFile, JSON.stringify({ format: 'json' }));
      const result = readYamlOrJson<{ format: string }>(jsonFile);
      expect(result).to.deep.equal({ format: 'json' });
    });

    it('reads YAML file based on extension', () => {
      const yamlFile = path.join(testDir, 'test.yaml');
      fs.writeFileSync(yamlFile, 'format: yaml\n');
      const result = readYamlOrJson<{ format: string }>(yamlFile);
      expect(result).to.deep.equal({ format: 'yaml' });
    });

    it('reads .yml file', () => {
      const ymlFile = path.join(testDir, 'test.yml');
      fs.writeFileSync(ymlFile, 'format: yml\n');
      const result = readYamlOrJson<{ format: string }>(ymlFile);
      expect(result).to.deep.equal({ format: 'yml' });
    });

    it('uses explicit format override', () => {
      // Write YAML content but with .txt extension, read with explicit format
      const txtFile = path.join(testDir, 'test.txt');
      fs.writeFileSync(txtFile, 'key: value\n');
      const result = readYamlOrJson<{ key: string }>(txtFile, 'yaml');
      expect(result).to.deep.equal({ key: 'value' });
    });

    it('throws for unknown format', () => {
      const txtFile = path.join(testDir, 'test.txt');
      fs.writeFileSync(txtFile, 'content');
      expect(() => readYamlOrJson(txtFile)).to.throw('Invalid file format');
    });
  });

  describe('readYamlOrJson - empty files', () => {
    it('returns null for empty JSON file', () => {
      const jsonFile = path.join(testDir, 'empty.json');
      fs.writeFileSync(jsonFile, '');
      const result = readYamlOrJson(jsonFile);
      expect(result).to.be.null;
    });

    it('returns null for empty YAML file (.yaml)', () => {
      const yamlFile = path.join(testDir, 'empty.yaml');
      fs.writeFileSync(yamlFile, '');
      const result = readYamlOrJson(yamlFile);
      expect(result).to.be.null;
    });

    it('returns null for empty YAML file (.yml)', () => {
      const ymlFile = path.join(testDir, 'empty.yml');
      fs.writeFileSync(ymlFile, '');
      const result = readYamlOrJson(ymlFile);
      expect(result).to.be.null;
    });

    it('returns null for empty file with explicit json format', () => {
      const txtFile = path.join(testDir, 'empty.txt');
      fs.writeFileSync(txtFile, '');
      const result = readYamlOrJson(txtFile, 'json');
      expect(result).to.be.null;
    });

    it('returns null for empty file with explicit yaml format', () => {
      const txtFile = path.join(testDir, 'empty.txt');
      fs.writeFileSync(txtFile, '');
      const result = readYamlOrJson(txtFile, 'yaml');
      expect(result).to.be.null;
    });

    it('returns null for JSON file with only whitespace', () => {
      const jsonFile = path.join(testDir, 'whitespace.json');
      fs.writeFileSync(jsonFile, '   \n\t  \n');
      const result = readYamlOrJson(jsonFile);
      expect(result).to.be.null;
    });

    it('returns null for YAML file with only whitespace', () => {
      const yamlFile = path.join(testDir, 'whitespace.yaml');
      fs.writeFileSync(yamlFile, '   \n\t  \n');
      const result = readYamlOrJson(yamlFile);
      expect(result).to.be.null;
    });

    it('returns null for YAML file with only comments', () => {
      const yamlFile = path.join(testDir, 'comments.yaml');
      fs.writeFileSync(yamlFile, '# comment\n# another comment\n');
      const result = readYamlOrJson(yamlFile);
      expect(result).to.be.null;
    });

    it('throws for malformed JSON file', () => {
      const jsonFile = path.join(testDir, 'malformed.json');
      fs.writeFileSync(jsonFile, '{ invalid json }');
      expect(() => readYamlOrJson(jsonFile)).to.throw();
    });
  });

  describe('writeYamlOrJson', () => {
    it('writes JSON file based on extension', () => {
      const jsonFile = path.join(testDir, 'test.json');
      writeYamlOrJson(jsonFile, { format: 'json' });
      const content = fs.readFileSync(jsonFile, 'utf8');
      expect(JSON.parse(content)).to.deep.equal({ format: 'json' });
    });

    it('writes YAML file based on extension', () => {
      const yamlFile = path.join(testDir, 'test.yaml');
      writeYamlOrJson(yamlFile, { format: 'yaml' });
      const result = readYamlOrJson<{ format: string }>(yamlFile);
      expect(result).to.deep.equal({ format: 'yaml' });
    });

    it('writes arrays', () => {
      const jsonFile = path.join(testDir, 'array.json');
      writeYamlOrJson(jsonFile, [1, 2, 3]);
      const result = readYamlOrJson<number[]>(jsonFile);
      expect(result).to.deep.equal([1, 2, 3]);
    });

    it('uses explicit format override', () => {
      const txtFile = path.join(testDir, 'test.txt');
      writeYamlOrJson(txtFile, { key: 'value' }, 'yaml');
      const content = fs.readFileSync(txtFile, 'utf8');
      expect(content.trimEnd()).to.equal('key: value');
    });

    it('throws for unknown format', () => {
      const txtFile = path.join(testDir, 'test.txt');
      expect(() => writeYamlOrJson(txtFile, { key: 'value' })).to.throw(
        'Invalid file format',
      );
    });
  });

  describe('mergeYamlOrJson', () => {
    it('creates JSON file if it does not exist', () => {
      const jsonFile = path.join(testDir, 'new.json');
      mergeYamlOrJson(jsonFile, { key: 'value' }, 'json');
      const result = readYamlOrJson<{ key: string }>(jsonFile);
      expect(result).to.deep.equal({ key: 'value' });
    });

    it('creates YAML file if it does not exist (default)', () => {
      const yamlFile = path.join(testDir, 'new.yaml');
      mergeYamlOrJson(yamlFile, { key: 'value' });
      const result = readYamlOrJson<{ key: string }>(yamlFile);
      expect(result).to.deep.equal({ key: 'value' });
    });

    it('merges with existing JSON content', () => {
      const jsonFile = path.join(testDir, 'existing.json');
      writeYamlOrJson(jsonFile, { existing: 'data' });
      mergeYamlOrJson(jsonFile, { new: 'data' }, 'json');
      const result = readYamlOrJson<Record<string, string>>(jsonFile);
      expect(result).to.deep.equal({ existing: 'data', new: 'data' });
    });

    it('merges with existing YAML content', () => {
      const yamlFile = path.join(testDir, 'existing.yaml');
      writeYamlOrJson(yamlFile, { existing: 'data' });
      mergeYamlOrJson(yamlFile, { new: 'data' });
      const result = readYamlOrJson<Record<string, string>>(yamlFile);
      expect(result).to.deep.equal({ existing: 'data', new: 'data' });
    });
  });
});
