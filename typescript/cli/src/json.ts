import fs from 'fs';
import path from 'path';

import { objMerge } from '@hyperlane-xyz/sdk';

export function readFileAtPath(filepath: string) {
  if (!fs.existsSync(filepath)) {
    throw Error(`file doesn't exist at ${filepath}`);
  }
  return fs.readFileSync(filepath, 'utf8');
}

export function readJSONAtPath<T>(filepath: string): T {
  return JSON.parse(readFileAtPath(filepath)) as T;
}

export function readJSON<T>(directory: string, filename: string): T {
  return readJSONAtPath(path.join(directory, filename));
}

export function tryReadJSON<T>(directory: string, filename: string): T | null {
  try {
    return readJSONAtPath(path.join(directory, filename)) as T;
  } catch (error) {
    return null;
  }
}

export function writeFileAtPath(
  directory: string,
  filename: string,
  value: string,
) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(directory, filename), value);
}

export function writeJSON(directory: string, filename: string, obj: any) {
  writeFileAtPath(directory, filename, JSON.stringify(obj, null, 2) + '\n');
}

export function mergeJSON<T extends Record<string, any>>(
  directory: string,
  filename: string,
  obj: T,
) {
  if (fs.existsSync(path.join(directory, filename))) {
    const previous = readJSON<T>(directory, filename);
    writeJSON(directory, filename, objMerge(previous, obj));
  } else {
    writeJSON(directory, filename, obj);
  }
}
