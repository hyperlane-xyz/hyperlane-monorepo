import fs from 'fs';
import path from 'path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

import { objMerge } from '@hyperlane-xyz/sdk';

export type FileFormat = 'yaml' | 'json';

export function readFileAtPath(filepath: string) {
  if (!fs.existsSync(filepath)) {
    throw Error(`File doesn't exist at ${filepath}`);
  }
  return fs.readFileSync(filepath, 'utf8');
}

export function writeFileAtPath(filepath: string, value: string) {
  const dirname = path.dirname(filepath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
  fs.writeFileSync(filepath, value);
}

export function readJson<T>(filepath: string): T {
  return JSON.parse(readFileAtPath(filepath)) as T;
}

export function tryReadJson<T>(filepath: string): T | null {
  try {
    return readJson(filepath) as T;
  } catch (error) {
    return null;
  }
}

export function writeJson(filepath: string, obj: any) {
  writeFileAtPath(filepath, JSON.stringify(obj, null, 2) + '\n');
}

export function mergeJson<T extends Record<string, any>>(
  filepath: string,
  obj: T,
) {
  if (fs.existsSync(filepath)) {
    const previous = readJson<T>(filepath);
    writeJson(filepath, objMerge(previous, obj));
  } else {
    writeJson(filepath, obj);
  }
}

export function readYaml<T>(filepath: string): T {
  return yamlParse(readFileAtPath(filepath)) as T;
}

export function tryReadYamlAtPath<T>(filepath: string): T | null {
  try {
    return readYaml(filepath);
  } catch (error) {
    return null;
  }
}

export function writeYaml(filepath: string, obj: any) {
  writeFileAtPath(filepath, yamlStringify(obj, null, 2) + '\n');
}

export function mergeYaml<T extends Record<string, any>>(
  filepath: string,
  obj: T,
) {
  if (fs.existsSync(filepath)) {
    console.log('MERGING');
    const previous = readYaml<T>(filepath);
    console.log('MERGING', previous);
    writeYaml(filepath, objMerge(previous, obj));
  } else {
    writeYaml(filepath, obj);
  }
}

export function readYamlOrJson<T>(filepath: string, format?: FileFormat): T {
  return resolveYamlOrJson(filepath, readJson, readYaml, format);
}

export function writeYamlOrJson(
  filepath: string,
  obj: Record<string, any>,
  format?: FileFormat,
) {
  return resolveYamlOrJson(
    filepath,
    (f: string) => writeJson(f, obj),
    (f: string) => writeYaml(f, obj),
    format,
  );
}

export function mergeYamlOrJson(
  filepath: string,
  obj: Record<string, any>,
  format?: FileFormat,
) {
  return resolveYamlOrJson(
    filepath,
    (f: string) => mergeJson(f, obj),
    (f: string) => mergeYaml(f, obj),
    format,
  );
}

function resolveYamlOrJson(
  filepath: string,
  jsonFn: any,
  yamlFn: any,
  format?: FileFormat,
) {
  if (format === 'json' || filepath.endsWith('.json')) {
    return jsonFn(filepath);
  } else if (
    format === 'yaml' ||
    filepath.endsWith('.yaml') ||
    filepath.endsWith('.yml')
  ) {
    return yamlFn(filepath);
  } else {
    throw new Error(`Invalid file format for ${filepath}`);
  }
}
