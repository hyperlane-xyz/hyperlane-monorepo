import path from 'path';
import {
  DocumentOptions,
  ParseOptions,
  SchemaOptions,
  ToJSOptions,
  parse,
} from 'yaml';

import { objMerge, stringifyObject } from '../objects.js';

import { isFile, readFileAtPath, writeToFile } from './utils.js';

type YamlParseOptions = ParseOptions &
  DocumentOptions &
  SchemaOptions &
  ToJSOptions;

/**
 * Parses YAML content with sensible defaults.
 * @see stackoverflow.com/questions/63075256/why-does-the-npm-yaml-library-have-a-max-alias-number
 */
export function yamlParse<T>(content: string, options?: YamlParseOptions): T {
  return parse(content, { maxAliasCount: -1, ...options }) as T;
}

/**
 * Reads and parses a YAML file.
 */
export function readYaml<T>(filepath: string): T {
  return yamlParse<T>(readFileAtPath(filepath));
}

/**
 * Attempts to read and parse a YAML file, returning null if it fails.
 */
export function tryReadYaml<T>(filepath: string): T | null {
  try {
    return readYaml(filepath);
  } catch {
    return null;
  }
}

/**
 * Writes an object as YAML to a file with a trailing newline.
 * Uses stringifyObject to properly handle ethers BigNumber serialization.
 */
export function writeYaml(filepath: string, obj: unknown): void {
  writeToFile(filepath, stringifyObject(obj, 'yaml', 2).trimEnd());
}

/**
 * Merges an object with existing YAML file content and writes the result.
 * If the file doesn't exist, writes the object directly.
 */
export function mergeYaml<T extends Record<string, unknown>>(
  filepath: string,
  obj: T,
): void {
  if (isFile(filepath)) {
    const previous = readYaml<T>(filepath);
    writeYaml(filepath, objMerge(previous, obj));
  } else {
    writeYaml(filepath, obj);
  }
}

/**
 * Reads YAML from a directory with the specified filename.
 */
export function readYamlFromDir<T>(directory: string, filename: string): T {
  return readYaml<T>(path.join(directory, filename));
}
