import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export const SUPPORTED_RUNTIME_PRIMITIVE_VALUE_TYPES = [
  'string',
  'number',
  'boolean',
  'bigint',
  'undefined',
  'symbol',
] as const;

export type SupportedRuntimePrimitiveValueType =
  (typeof SUPPORTED_RUNTIME_PRIMITIVE_VALUE_TYPES)[number];

export type CleanRuntimeProbeLabels = {
  functionLabels: string[];
  objectLabels: string[];
  primitiveLabels: string[];
};

const INFERENCE_TEST_FILE_PREFIX = 'inference.';
const INFERENCE_TEST_FILE_SUFFIX = '.test.ts';
const OBJECT_LIKE_PROBE_LABEL_REGEX = /[a-z0-9_-]+-(?:constructor-)?object/g;

export function isSupportedRuntimePrimitiveValueType(
  valueType: string,
): valueType is SupportedRuntimePrimitiveValueType {
  return (
    SUPPORTED_RUNTIME_PRIMITIVE_VALUE_TYPES as readonly string[]
  ).includes(valueType);
}

const cleanRuntimeProbeLabels: CleanRuntimeProbeLabels = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--no-warnings',
      '-e',
      `
        const primitiveTypes = ${JSON.stringify(SUPPORTED_RUNTIME_PRIMITIVE_VALUE_TYPES)};
        const functionLabels = Object.getOwnPropertyNames(globalThis)
          .filter((name) => typeof globalThis[name] === 'function')
          .map((name) => \`\${name.toLowerCase()}-constructor-object\`)
          .sort();
        const objectLabels = Object.getOwnPropertyNames(globalThis)
          .filter((name) => {
            const value = globalThis[name];
            return value !== null && typeof value === 'object';
          })
          .map((name) => \`\${name.toLowerCase()}-object\`)
          .sort();
        const primitiveLabels = Object.getOwnPropertyNames(globalThis)
          .filter((name) => primitiveTypes.includes(typeof globalThis[name]))
          .map((name) => \`\${name.toLowerCase()}-\${typeof globalThis[name]}-primitive\`)
          .sort();
        process.stdout.write(JSON.stringify({ functionLabels, objectLabels, primitiveLabels }));
      `,
    ],
    { encoding: 'utf8' },
  ),
) as CleanRuntimeProbeLabels;

export function getCleanRuntimeProbeLabels(): CleanRuntimeProbeLabels {
  return cleanRuntimeProbeLabels;
}

export function getKnownObjectLikeProbeLabelsFromOtherTests(
  currentFilePath: string,
): Set<string> {
  const knownLabelsFromOtherFiles = new Set<string>();
  const currentFileName = path.basename(currentFilePath);
  const submitterTestDir = path.dirname(currentFilePath);

  for (const fileName of fs.readdirSync(submitterTestDir)) {
    if (
      !fileName.startsWith(INFERENCE_TEST_FILE_PREFIX) ||
      !fileName.endsWith(INFERENCE_TEST_FILE_SUFFIX) ||
      fileName === currentFileName
    ) {
      continue;
    }

    const fileContent = fs.readFileSync(
      path.join(submitterTestDir, fileName),
      'utf8',
    );
    for (const match of fileContent.matchAll(OBJECT_LIKE_PROBE_LABEL_REGEX)) {
      knownLabelsFromOtherFiles.add(match[0]);
    }
  }

  return knownLabelsFromOtherFiles;
}

export function getRuntimeFunctionValuesByLabel(): Map<string, Function> {
  const runtimeFunctionValueByLabel = new Map<string, Function>();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    const value = (globalThis as any)[name];
    if (typeof value === 'function') {
      runtimeFunctionValueByLabel.set(
        `${name.toLowerCase()}-constructor-object`,
        value,
      );
    }
  }
  return runtimeFunctionValueByLabel;
}

export function getRuntimeObjectValuesByLabel(): Map<string, object> {
  const runtimeObjectValueByLabel = new Map<string, object>();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    const value = (globalThis as any)[name];
    if (value !== null && typeof value === 'object') {
      runtimeObjectValueByLabel.set(`${name.toLowerCase()}-object`, value);
    }
  }
  return runtimeObjectValueByLabel;
}

export function getRuntimePrimitiveValuesByLabel(): Map<string, unknown> {
  const runtimePrimitiveByLabel = new Map<string, unknown>();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    const value = (globalThis as any)[name];
    const valueType = typeof value;
    if (isSupportedRuntimePrimitiveValueType(valueType)) {
      runtimePrimitiveByLabel.set(
        `${name.toLowerCase()}-${valueType}-primitive`,
        value,
      );
    }
  }
  return runtimePrimitiveByLabel;
}
