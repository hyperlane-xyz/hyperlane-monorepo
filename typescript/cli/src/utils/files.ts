import { input } from '@inquirer/prompts';
import select from '@inquirer/select';
import fs from 'fs';
import path from 'path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

import { objMerge } from '@hyperlane-xyz/utils';

import { log, logBlue } from '../logger.js';

import { getTimestampForFilename } from './time.js';

export type FileFormat = 'yaml' | 'json';

export type ArtifactsFile = {
  filename: string;
  description: string;
};

export function isFile(filepath: string) {
  if (!filepath) return false;
  try {
    return fs.existsSync(filepath) && fs.lstatSync(filepath).isFile();
  } catch (error) {
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
  if (isFile(filepath)) {
    const previous = readYaml<T>(filepath);
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

export function prepNewArtifactsFiles(
  outPath: string,
  files: Array<ArtifactsFile>,
) {
  const timestamp = getTimestampForFilename();
  const newPaths: string[] = [];
  for (const file of files) {
    const filePath = path.join(outPath, `${file.filename}-${timestamp}.json`);
    // Write empty object to ensure permissions are okay
    writeJson(filePath, {});
    newPaths.push(filePath);
    logBlue(`${file.description} will be written to ${filePath}`);
  }
  return newPaths;
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
  else throw new Error(`No filepath entered ${description}`);
}
