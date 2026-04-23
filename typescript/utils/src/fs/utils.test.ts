import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'vitest';

import {
  ensureDirectoryExists,
  isFile,
  pathExists,
  readFileAtPath,
  removeTrailingSlash,
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

  describe('removeTrailingSlash', () => {
    it('removes trailing slash', () => {
      expect(removeTrailingSlash('/path/to/dir/')).toBe('/path/to/dir');
    });

    it('leaves path without trailing slash unchanged', () => {
      expect(removeTrailingSlash('/path/to/dir')).toBe('/path/to/dir');
    });

    it('handles empty string', () => {
      expect(removeTrailingSlash('')).toBe('');
    });
  });

  describe('resolvePath', () => {
    it('expands ~ to home directory', () => {
      const result = resolvePath('~/test');
      expect(result).toBe(path.join(os.homedir(), 'test'));
    });

    it('leaves absolute paths unchanged', () => {
      expect(resolvePath('/absolute/path')).toBe('/absolute/path');
    });

    it('leaves relative paths unchanged', () => {
      expect(resolvePath('relative/path')).toBe('relative/path');
    });
  });

  describe('isFile', () => {
    it('returns false for empty filepath', () => {
      expect(isFile('')).toBe(false);
    });

    it('returns false for non-existent path', () => {
      expect(isFile('/non/existent/path')).toBe(false);
    });

    it('returns true for existing file', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, 'test content');
      expect(isFile(testFile)).toBe(true);
    });

    it('returns false for directory', () => {
      fs.mkdirSync(testDir, { recursive: true });
      expect(isFile(testDir)).toBe(false);
    });
  });

  describe('pathExists', () => {
    it('returns false for non-existent path', () => {
      expect(pathExists('/non/existent/path')).toBe(false);
    });

    it('returns true for existing file', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, 'test content');
      expect(pathExists(testFile)).toBe(true);
    });

    it('returns true for existing directory', () => {
      fs.mkdirSync(testDir, { recursive: true });
      expect(pathExists(testDir)).toBe(true);
    });
  });

  describe('readFileAtPath', () => {
    it('reads file content', () => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, 'test content');
      expect(readFileAtPath(testFile)).toBe('test content');
    });

    it('throws for non-existent file', () => {
      expect(() => readFileAtPath('/non/existent/file')).toThrow(
        "File doesn't exist",
      );
    });
  });

  describe('ensureDirectoryExists', () => {
    it('creates directory if it does not exist', () => {
      const nestedPath = path.join(testDir, 'nested', 'dir', 'file.txt');
      ensureDirectoryExists(nestedPath);
      expect(fs.existsSync(path.dirname(nestedPath))).toBe(true);
    });

    it('does nothing if directory already exists', () => {
      fs.mkdirSync(testDir, { recursive: true });
      ensureDirectoryExists(testFile);
      expect(fs.existsSync(testDir)).toBe(true);
    });
  });

  describe('writeFileAtPath', () => {
    it('writes content to file', () => {
      writeFileAtPath(testFile, 'test content');
      expect(fs.readFileSync(testFile, 'utf8')).toBe('test content');
    });

    it('creates directory if it does not exist', () => {
      const nestedFile = path.join(testDir, 'nested', 'file.txt');
      writeFileAtPath(nestedFile, 'nested content');
      expect(fs.readFileSync(nestedFile, 'utf8')).toBe('nested content');
    });

    it('overwrites existing file', () => {
      writeFileAtPath(testFile, 'original');
      writeFileAtPath(testFile, 'updated');
      expect(fs.readFileSync(testFile, 'utf8')).toBe('updated');
    });
  });

  describe('writeToFile', () => {
    it('writes content with trailing newline', () => {
      writeToFile(testFile, 'test content');
      expect(fs.readFileSync(testFile, 'utf8')).toBe('test content\n');
    });
  });
});
