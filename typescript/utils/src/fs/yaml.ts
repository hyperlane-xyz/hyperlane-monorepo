import path from 'path';
import {
  DocumentOptions,
  ParseOptions,
  SchemaOptions,
  ToJSOptions,
  parse,
  stringify as yamlStringify,
} from 'yaml';

import { objMerge } from '../objects.js';

import { isFile, readFileAtPath, writeToFile } from './utils.js';

type YamlParseOptions = ParseOptions &
  DocumentOptions &
  SchemaOptions &
  ToJSOptions;

/**
 * Parses YAML content with sensible defaults.
 * Note: No validation is performed - callers are responsible for ensuring type safety.
 * @see stackoverflow.com/questions/63075256/why-does-the-npm-yaml-library-have-a-max-alias-number
 */
export function yamlParse(content: string, options?: YamlParseOptions) {
  return parse(content, { maxAliasCount: -1, ...options });
}

/**
 * Reads and parses a YAML file.
 * Note: No validation is performed - callers are responsible for ensuring type safety.
 */
export function readYaml(filepath: string) {
  return yamlParse(readFileAtPath(filepath));
}

/**
 * Attempts to read and parse a YAML file, returning null if it fails.
 * Note: No validation is performed - callers are responsible for ensuring type safety.
 */
export function tryReadYaml(filepath: string) {
  try {
    return readYaml(filepath);
  } catch {
    return null;
  }
}

/**
 * Writes an object as YAML to a file with a trailing newline.
 */
export function writeYaml(filepath: string, obj: unknown): void {
  writeToFile(
    filepath,
    yamlStringify(obj, { indent: 2, sortMapEntries: true }).trimEnd(),
  );
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
    const previous = readYaml(filepath);
    writeYaml(filepath, objMerge(previous, obj));
  } else {
    writeYaml(filepath, obj);
  }
}

/**
 * Reads YAML from a directory with the specified filename.
 * Note: No validation is performed - callers are responsible for ensuring type safety.
 */
export function readYamlFromDir(directory: string, filename: string) {
  return readYaml(path.join(directory, filename));
}
