import { execFileSync } from 'child_process';

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
