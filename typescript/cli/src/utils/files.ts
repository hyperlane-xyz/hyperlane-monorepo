import { input } from '@inquirer/prompts';
import select from '@inquirer/select';
import fs from 'fs';
import path from 'path';
import { LineCounter, stringify as yamlStringify } from 'yaml';

import {
  indentYamlOrJson,
  // Re-export core fs utilities from utils/fs
  isFile,
  mergeJson,
  mergeYaml,
  mergeYamlOrJson,
  readFileAtPath,
  readJson,
  readYaml,
  readYamlOrJson,
  removeEndingSlash,
  resolveFileFormat,
  resolvePath,
  tryReadJson,
  tryReadYaml,
  writeFileAtPath,
  writeJson,
  writeYaml,
  writeYamlOrJson,
  yamlParse,
} from '@hyperlane-xyz/utils/fs';

import { log } from '../logger.js';

export type { FileFormat } from '@hyperlane-xyz/utils/fs';

// Re-export all the core fs utilities
export {
  isFile,
  readFileAtPath,
  writeFileAtPath,
  removeEndingSlash,
  resolvePath,
  readJson,
  tryReadJson,
  writeJson,
  mergeJson,
  readYaml,
  tryReadYaml,
  writeYaml,
  mergeYaml,
  readYamlOrJson,
  writeYamlOrJson,
  mergeYamlOrJson,
  resolveFileFormat,
  indentYamlOrJson,
};

export const MAX_READ_LINE_OUTPUT = 250;

export type ArtifactsFile = {
  filename: string;
  description: string;
};

/**
 * @deprecated Use tryReadYaml from @hyperlane-xyz/utils/fs instead
 */
export const tryReadYamlAtPath = tryReadYaml;

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
