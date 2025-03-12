import { input } from '@inquirer/prompts';
import select from '@inquirer/select';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DocumentOptions,
  LineCounter,
  ParseOptions,
  SchemaOptions,
  ToJSOptions,
  parse,
  stringify as yamlStringify,
} from 'yaml';

import { objMerge } from '@hyperlane-xyz/utils';

import { log } from '../logger.js';

const yamlParse = (
  content: string,
  options?: ParseOptions & DocumentOptions & SchemaOptions & ToJSOptions,
) =>
  // See stackoverflow.com/questions/63075256/why-does-the-npm-yaml-library-have-a-max-alias-number
  parse(content, { maxAliasCount: -1, ...options });

export const MAX_READ_LINE_OUTPUT = 250;

export type FileFormat = 'yaml' | 'json';

export type ArtifactsFile = {
  filename: string;
  description: string;
};

export function removeEndingSlash(dirPath: string): string {
  if (dirPath.endsWith('/')) {
    return dirPath.slice(0, -1);
  }
  return dirPath;
}

export function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const homedir = os.homedir();
    return path.join(homedir, filePath.slice(1));
  }
  return filePath;
}

export function isFile(filepath: string) {
  if (!filepath) return false;
  try {
    return fs.existsSync(filepath) && fs.lstatSync(filepath).isFile();
  } catch {
    log(`Error checking for file: ${filepath}`);
    return false;
  }
}

export function readFileAtPath(filepath: string) {
  if (!isFile(filepath)) {
    throw Error(`File doesn't exist at ${filepath}`);
  }
  return fs.readFileSync(filepath, 'utf8');
}

export function writeFileAtPath(filepath: string, value: string) {
  const dirname = path.dirname(filepath);
  if (!isFile(dirname)) {
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
  } catch {
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
  if (isFile(filepath)) {
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
  } catch {
    return null;
  }
}

export function writeYaml(filepath: string, obj: any) {
  writeFileAtPath(
    filepath,
    yamlStringify(obj, { indent: 2, sortMapEntries: true }) + '\n',
  );
}

export function mergeYaml<T extends Record<string, any>>(
  filepath: string,
  obj: T,
) {
  if (isFile(filepath)) {
    const previous = readYaml<T>(filepath);
    writeYaml(filepath, objMerge(previous, obj));
  } else {
    writeYaml(filepath, obj);
  }
}

export function readYamlOrJson<T>(filepath: string, format?: FileFormat): T {
  return resolveYamlOrJsonFn(filepath, readJson, readYaml, format);
}

export function writeYamlOrJson(
  filepath: string,
  obj: Record<string, any>,
  format?: FileFormat,
) {
  return resolveYamlOrJsonFn(
    filepath,
    (f: string) => writeJson(f, obj),
    (f: string) => writeYaml(f, obj),
    format,
  );
}

export function mergeYamlOrJson(
  filepath: string,
  obj: Record<string, any>,
  format: FileFormat = 'yaml',
) {
  return resolveYamlOrJsonFn(
    filepath,
    (f: string) => mergeJson(f, obj),
    (f: string) => mergeYaml(f, obj),
    format,
  );
}

function resolveYamlOrJsonFn(
  filepath: string,
  jsonFn: any,
  yamlFn: any,
  format?: FileFormat,
) {
  const fileFormat = resolveFileFormat(filepath, format);
  if (!fileFormat) {
    throw new Error(`Invalid file format for ${filepath}`);
  }

  if (fileFormat === 'json') {
    return jsonFn(filepath);
  }

  return yamlFn(filepath);
}

export function resolveFileFormat(
  filepath?: string,
  format?: FileFormat,
): FileFormat | undefined {
  // early out if filepath is undefined
  if (!filepath) {
    return format;
  }

  if (format === 'json' || filepath?.endsWith('.json')) {
    return 'json';
  }

  if (
    format === 'yaml' ||
    filepath?.endsWith('.yaml') ||
    filepath?.endsWith('.yml')
  ) {
    return 'yaml';
  }

  return undefined;
}

export async function runFileSelectionStep(
  folderPath: string,
  description: string,
  pattern?: string,
) {
  const noFilesErrorMessage = `No "${description}" found in ${folderPath}. Please confirm the path for "${description}". By default, the CLI writes to folders relative to where its run.`;
  if (!fs.existsSync(folderPath)) throw new Error(noFilesErrorMessage);

  let filenames = fs.readdirSync(folderPath);
  if (pattern) {
    filenames = filenames.filter((f) => f.includes(pattern));
  }

  if (filenames.length === 0) throw new Error(noFilesErrorMessage);

  let filename = (await select({
    message: `Select ${description} file`,
    choices: [
      ...filenames.map((f) => ({ name: f, value: f })),
      { name: '(Other file)', value: null },
    ],
    pageSize: 20,
  })) as string;

  if (filename) return path.join(folderPath, filename);

  filename = await input({
    message: `Enter ${description} filepath`,
  });

  if (filename) return filename;
  else throw new Error(`No filepath entered for ${description}`);
}

export function indentYamlOrJson(str: string, indentLevel: number): string {
  const indent = ' '.repeat(indentLevel);
  return str
    .split('\n')
    .map((line) => indent + line)
    .join('\n');
}

/**
 * Logs the YAML representation of an object if the number of lines is less than the specified maximum.
 *
 * @param obj - The object to be converted to YAML.
 * @param maxLines - The maximum number of lines allowed for the YAML representation.
 * @param margin - The number of spaces to use for indentation (default is 2).
 */
export function logYamlIfUnderMaxLines(
  obj: any,
  maxLines: number = MAX_READ_LINE_OUTPUT,
  margin: number = 2,
): void {
  const asYamlString = yamlStringify(obj, null, margin);
  const lineCounter = new LineCounter();
  yamlParse(asYamlString, { lineCounter });

  log(lineCounter.lineStarts.length < maxLines ? asYamlString : '');
}
