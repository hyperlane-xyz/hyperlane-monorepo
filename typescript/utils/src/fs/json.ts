import path from 'path';

import { objMerge } from '../objects.js';

import { isFile, pathExists, readFileAtPath, writeToFile } from './utils.js';

/**
 * Reads and parses a JSON file.
 */
export function readJson<T>(filepath: string): T {
  return JSON.parse(readFileAtPath(filepath)) as T;
}

/**
 * Attempts to read and parse a JSON file, returning null if it fails.
 */
export function tryReadJson<T>(filepath: string): T | null {
  try {
    return readJson(filepath) as T;
  } catch {
    return null;
  }
}

/**
 * Writes an object as JSON to a file with a trailing newline.
 */
export function writeJson(filepath: string, obj: unknown): void {
  writeToFile(filepath, JSON.stringify(obj, null, 2));
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
    const previous = readJson<T>(filepath);
    writeJson(filepath, objMerge(previous, obj));
  } else {
    writeJson(filepath, obj);
  }
}

/**
 * Reads JSON from a directory with the specified filename.
 */
export function readJsonFromDir<T>(directory: string, filename: string): T {
  return readJson<T>(path.join(directory, filename));
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
    const existing = readJson<Record<string, unknown>>(filepath);
    // Merge newData into existing, preserving existing values for keys that already exist
    data = { ...newData, ...existing };
  }
  writeJson(filepath, data);
}
