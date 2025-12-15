import { mergeJson, readJson, writeJson } from './json.js';
import { mergeYaml, readYaml, writeYaml } from './yaml.js';

export type FileFormat = 'yaml' | 'json';

/**
 * Resolves the file format based on filepath extension or explicit format.
 */
export function resolveFileFormat(
  filepath?: string,
  format?: FileFormat,
): FileFormat | undefined {
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

/**
 * Indents a multi-line string by the specified number of spaces.
 */
export function indentYamlOrJson(str: string, indentLevel: number): string {
  const indent = ' '.repeat(indentLevel);
  return str
    .split('\n')
    .map((line) => indent + line)
    .join('\n');
}

function resolveYamlOrJsonFn<T>(
  filepath: string,
  jsonFn: (filepath: string) => T,
  yamlFn: (filepath: string) => T,
  format?: FileFormat,
): T {
  const fileFormat = resolveFileFormat(filepath, format);
  if (!fileFormat) {
    throw new Error(`Invalid file format for ${filepath}`);
  }

  if (fileFormat === 'json') {
    return jsonFn(filepath);
  }

  return yamlFn(filepath);
}

/**
 * Reads and parses a YAML or JSON file based on extension or explicit format.
 */
export function readYamlOrJson<T>(filepath: string, format?: FileFormat): T {
  return resolveYamlOrJsonFn<T>(filepath, readJson<T>, readYaml<T>, format);
}

/**
 * Writes a value as YAML or JSON based on extension or explicit format.
 */
export function writeYamlOrJson(
  filepath: string,
  obj: unknown,
  format?: FileFormat,
): void {
  resolveYamlOrJsonFn(
    filepath,
    (f: string) => writeJson(f, obj),
    (f: string) => writeYaml(f, obj),
    format,
  );
}

/**
 * Merges an object with existing file content and writes the result.
 * Format is determined by extension or explicit format (defaults to yaml).
 */
export function mergeYamlOrJson(
  filepath: string,
  obj: Record<string, unknown>,
  format: FileFormat = 'yaml',
): void {
  resolveYamlOrJsonFn(
    filepath,
    (f: string) => mergeJson(f, obj),
    (f: string) => mergeYaml(f, obj),
    format,
  );
}
