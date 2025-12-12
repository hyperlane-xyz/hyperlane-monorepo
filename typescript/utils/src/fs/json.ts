import path from 'path';

import { objMerge, stringifyObject } from '../objects.js';

import { isFile, pathExists, readFileAtPath, writeToFile } from './utils.js';

/**
 * Reads and parses a JSON file.
 * Note: No validation is performed - callers are responsible for ensuring type safety.
 */
export function readJson(filepath: string) {
  return JSON.parse(readFileAtPath(filepath));
}

/**
 * Attempts to read and parse a JSON file, returning null if it fails.
 * Note: No validation is performed - callers are responsible for ensuring type safety.
 */
export function tryReadJson(filepath: string) {
  try {
    return readJson(filepath);
  } catch {
    return null;
  }
}

/**
 * Writes an object as JSON to a file with a trailing newline.
 * Uses stringifyObject to properly handle ethers BigNumber serialization.
 */
export function writeJson(filepath: string, obj: unknown): void {
  writeToFile(filepath, stringifyObject(obj, 'json', 2));
}

/**
 * Merges an object with existing JSON file content and writes the result.
 * If the file doesn't exist, writes the object directly.
 */
export function mergeJson<T extends Record<string, unknown>>(
  filepath: string,
  obj: T,
): void {
  if (isFile(filepath)) {
    const previous = readJson(filepath);
    writeJson(filepath, objMerge(previous, obj));
  } else {
    writeJson(filepath, obj);
  }
}

/**
 * Reads JSON from a directory with the specified filename.
 * Note: No validation is performed - callers are responsible for ensuring type safety.
 */
export function readJsonFromDir(directory: string, filename: string) {
  return readJson(path.join(directory, filename));
}

/**
 * Writes JSON to a directory with the specified filename.
 */
export function writeJsonToDir(
  directory: string,
  filename: string,
  obj: unknown,
): void {
  writeJson(path.join(directory, filename), obj);
}

/**
 * Merges JSON in a directory with the specified filename.
 */
export function mergeJsonInDir<T extends Record<string, unknown>>(
  directory: string,
  filename: string,
  obj: T,
): void {
  mergeJson(path.join(directory, filename), obj);
}

/**
 * Write JSON to file, optionally preserving existing values for keys.
 * If appendMode is true, preserves all existing keys and their values,
 * only adding new keys from newData that don't exist in the file.
 */
export function writeJsonWithAppendMode(
  filepath: string,
  newData: Record<string, unknown>,
  appendMode: boolean,
): void {
  let data = newData;
  if (appendMode && pathExists(filepath)) {
    const existing = readJson(filepath);
    // Merge newData into existing, preserving existing values for keys that already exist
    data = { ...newData, ...existing };
  }
  writeJson(filepath, data);
}
