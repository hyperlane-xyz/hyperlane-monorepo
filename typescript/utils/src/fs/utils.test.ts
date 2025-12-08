import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ensureDirectoryExists,
  isFile,
  pathExists,
  readFileAtPath,
  removeEndingSlash,
  resolvePath,
  writeFileAtPath,
  writeToFile,
} from './utils.js';

describe('fs utilities', () => {
  const testDir = path.join(os.tmpdir(), 'hyperlane-fs-test');
  const testFile = path.join(testDir, 'test.txt');

  beforeEach(() => {
    // Clean up before each test
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up after each test
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('removeEndingSlash', () => {
    it('removes trailing slash', () => {
      expect(removeEndingSlash('/path/to/dir/')).to.equal('/path/to/dir');
    });

    it('leaves path without trailing slash unchanged', () => {
      expect(removeEndingSlash('/path/to/dir')).to.equal('/path/to/dir');
    });

    it('handles empty string', () => {
      expect(removeEndingSlash('')).to.equal('');
    });
  });

  describe('resolvePath', () => {
    it('expands ~ to home directory', () => {
      const result = resolvePath('~/test');
      expect(result).to.equal(path.join(os.homedir(), 'test'));
    });

    it('leaves absolute paths unchanged', () => {
      expect(resolvePath('/absolute/path')).to.equal('/absolute/path');
    });

    it('leaves relative paths unchanged', () => {
      expect(resolvePath('relative/path')).to.equal('relative/path');
    });
  });

  describe('isFile', () => {
    it('returns false for empty filepath', () => {
      expect(isFile('')).to.be.false;
    });

    it('returns false for non-existent path', () => {
      expect(isFile('/non/existent/path')).to.be.false;
    });

    it('returns true for existing file', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, 'test content');
      expect(isFile(testFile)).to.be.true;
    });

    it('returns false for directory', () => {
      fs.mkdirSync(testDir, { recursive: true });
      expect(isFile(testDir)).to.be.false;
    });
  });

  describe('pathExists', () => {
    it('returns false for non-existent path', () => {
      expect(pathExists('/non/existent/path')).to.be.false;
    });

    it('returns true for existing file', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, 'test content');
      expect(pathExists(testFile)).to.be.true;
    });

    it('returns true for existing directory', () => {
      fs.mkdirSync(testDir, { recursive: true });
      expect(pathExists(testDir)).to.be.true;
    });
  });

  describe('readFileAtPath', () => {
    it('reads file content', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, 'test content');
      expect(readFileAtPath(testFile)).to.equal('test content');
    });

    it('throws for non-existent file', () => {
      expect(() => readFileAtPath('/non/existent/file')).to.throw(
        "File doesn't exist",
      );
    });
  });

  describe('ensureDirectoryExists', () => {
    it('creates directory if it does not exist', () => {
      const nestedPath = path.join(testDir, 'nested', 'dir', 'file.txt');
      ensureDirectoryExists(nestedPath);
      expect(fs.existsSync(path.dirname(nestedPath))).to.be.true;
    });

    it('does nothing if directory already exists', () => {
      fs.mkdirSync(testDir, { recursive: true });
      ensureDirectoryExists(testFile);
      expect(fs.existsSync(testDir)).to.be.true;
    });
  });

  describe('writeFileAtPath', () => {
    it('writes content to file', () => {
      writeFileAtPath(testFile, 'test content');
      expect(fs.readFileSync(testFile, 'utf8')).to.equal('test content');
    });

    it('creates directory if it does not exist', () => {
      const nestedFile = path.join(testDir, 'nested', 'file.txt');
      writeFileAtPath(nestedFile, 'nested content');
      expect(fs.readFileSync(nestedFile, 'utf8')).to.equal('nested content');
    });

    it('overwrites existing file', () => {
      writeFileAtPath(testFile, 'original');
      writeFileAtPath(testFile, 'updated');
      expect(fs.readFileSync(testFile, 'utf8')).to.equal('updated');
    });
  });

  describe('writeToFile', () => {
    it('writes content with trailing newline', () => {
      writeToFile(testFile, 'test content');
      expect(fs.readFileSync(testFile, 'utf8')).to.equal('test content\n');
    });
  });
});
