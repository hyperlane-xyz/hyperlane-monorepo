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

type ReadonlyCleanRuntimeProbeLabels = {
  readonly functionLabels: readonly string[];
  readonly objectLabels: readonly string[];
  readonly primitiveLabels: readonly string[];
};

const INFERENCE_TEST_FILE_PREFIX = 'inference.';
const INFERENCE_TEST_FILE_SUFFIX = '.test.ts';
const OBJECT_LIKE_PROBE_LABEL_REGEX = /[a-z0-9_-]+-(?:constructor-)?object/g;
const EXCLUDED_INFERENCE_TEST_FILES = new Set([
  'inference.global-runtime-coverage.test.ts',
  'inference.runtime-globals.test.ts',
]);
const PROBE_LABEL_FROM_TEST_TITLE_REGEX =
  /^caches(?: event-derived)?(?: async)? ([a-z0-9_-]+-(?:constructor-)?object|[a-z0-9_-]+-primitive) origin signer probes across timelock ICA inferences$/;
const knownObjectLikeLabelsByFilePath = new Map<string, ReadonlySet<string>>();
const MISSING_GLOBAL_VALUE = Symbol('missing-global-value');

export function isSupportedRuntimePrimitiveValueType(
  valueType: string,
): valueType is SupportedRuntimePrimitiveValueType {
  return (
    SUPPORTED_RUNTIME_PRIMITIVE_VALUE_TYPES as readonly string[]
  ).includes(valueType);
}

const parsedCleanRuntimeProbeLabels = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--no-warnings',
      '-e',
      `
        const primitiveTypes = ${JSON.stringify(SUPPORTED_RUNTIME_PRIMITIVE_VALUE_TYPES)};
        const names = Object.getOwnPropertyNames(globalThis);
        const safeRead = (name) => {
          try {
            return { ok: true, value: globalThis[name] };
          } catch {
            return { ok: false, value: undefined };
          }
        };
        const globals = names.map((name) => ({ name, ...safeRead(name) }));
        const functionLabels = globals
          .filter((item) => item.ok && typeof item.value === 'function')
          .map((item) => \`\${item.name.toLowerCase()}-constructor-object\`)
          .sort();
        const objectLabels = globals
          .filter((item) => item.ok && item.value !== null && typeof item.value === 'object')
          .map((item) => \`\${item.name.toLowerCase()}-object\`)
          .sort();
        const primitiveLabels = globals
          .filter((item) => item.ok && primitiveTypes.includes(typeof item.value))
          .map((item) => \`\${item.name.toLowerCase()}-\${typeof item.value}-primitive\`)
          .sort();
        process.stdout.write(JSON.stringify({ functionLabels, objectLabels, primitiveLabels }));
      `,
    ],
    { encoding: 'utf8' },
  ),
) as CleanRuntimeProbeLabels;

const cleanRuntimeProbeLabels: ReadonlyCleanRuntimeProbeLabels = Object.freeze({
  functionLabels: Object.freeze([
    ...parsedCleanRuntimeProbeLabels.functionLabels,
  ]),
  objectLabels: Object.freeze([...parsedCleanRuntimeProbeLabels.objectLabels]),
  primitiveLabels: Object.freeze([
    ...parsedCleanRuntimeProbeLabels.primitiveLabels,
  ]),
});

export function getCleanRuntimeProbeLabels(): CleanRuntimeProbeLabels {
  return {
    functionLabels: [...cleanRuntimeProbeLabels.functionLabels],
    objectLabels: [...cleanRuntimeProbeLabels.objectLabels],
    primitiveLabels: [...cleanRuntimeProbeLabels.primitiveLabels],
  };
}

export function getKnownObjectLikeProbeLabelsFromOtherTests(
  currentFilePath: string,
): Set<string> {
  const normalizedFilePath = path.resolve(currentFilePath);
  const cached = knownObjectLikeLabelsByFilePath.get(normalizedFilePath);
  if (cached) {
    return new Set(cached);
  }

  const knownLabelsFromOtherFiles = new Set<string>();
  const currentFileName = path.basename(normalizedFilePath);
  const submitterTestDir = path.dirname(normalizedFilePath);
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(submitterTestDir);
  } catch {
    knownObjectLikeLabelsByFilePath.set(
      normalizedFilePath,
      knownLabelsFromOtherFiles,
    );
    return new Set(knownLabelsFromOtherFiles);
  }

  for (const fileName of fileNames) {
    if (
      !fileName.startsWith(INFERENCE_TEST_FILE_PREFIX) ||
      !fileName.endsWith(INFERENCE_TEST_FILE_SUFFIX) ||
      EXCLUDED_INFERENCE_TEST_FILES.has(fileName) ||
      fileName === currentFileName
    ) {
      continue;
    }

    let fileContent = '';
    try {
      fileContent = fs.readFileSync(
        path.join(submitterTestDir, fileName),
        'utf8',
      );
    } catch {
      continue;
    }
    for (const match of fileContent.matchAll(OBJECT_LIKE_PROBE_LABEL_REGEX)) {
      knownLabelsFromOtherFiles.add(match[0]);
    }
  }

  knownObjectLikeLabelsByFilePath.set(
    normalizedFilePath,
    knownLabelsFromOtherFiles,
  );
  return new Set(knownLabelsFromOtherFiles);
}

export function getRuntimeFunctionValuesByLabel(): Map<string, Function> {
  const runtimeFunctionValueByLabel = new Map<string, Function>();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    const value = tryGetGlobalValueByName(name);
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
    const value = tryGetGlobalValueByName(name);
    if (value !== null && typeof value === 'object') {
      runtimeObjectValueByLabel.set(`${name.toLowerCase()}-object`, value);
    }
  }
  return runtimeObjectValueByLabel;
}

export function getRuntimePrimitiveValuesByLabel(): Map<string, unknown> {
  const runtimePrimitiveByLabel = new Map<string, unknown>();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    const value = tryGetGlobalValueByName(name);
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

export function getProbeLabelFromInferenceTestTitle(
  title: string,
): string | null {
  const match = title.match(PROBE_LABEL_FROM_TEST_TITLE_REGEX);
  return match?.[1] ?? null;
}

export function getFallbackPrimitiveProbeValueFromLabel(
  label: string,
): unknown {
  if (label.endsWith('-undefined-primitive')) return undefined;
  if (label.endsWith('-number-primitive')) {
    if (label.startsWith('infinity-')) return Number.POSITIVE_INFINITY;
    if (label.startsWith('nan-')) return Number.NaN;
    return 0;
  }
  if (label.endsWith('-boolean-primitive')) return false;
  if (label.endsWith('-bigint-primitive')) return 0n;
  if (label.endsWith('-symbol-primitive')) return Symbol(label);
  if (label.endsWith('-string-primitive')) return label;
  return undefined;
}

function tryGetGlobalValueByName(name: string): unknown {
  try {
    return (globalThis as any)[name];
  } catch {
    return MISSING_GLOBAL_VALUE;
  }
}
