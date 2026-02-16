import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';

import {
  BUILTIN_SQUADS_ERROR_LABELS,
  DEFAULT_SQUADS_ERROR_PLACEHOLDER,
  SquadsTransactionReader,
  getSquadsChains,
  getSquadsKeysForResolvedChain,
  resolveSquadsChainName,
  normalizeStringifiedSquadsError,
  squadsConfigs,
  stringifyUnknownSquadsError,
} from './index.js';
import { SquadsTransactionReader as DirectSquadsTransactionReader } from './transaction-reader.js';
import {
  BUILTIN_SQUADS_ERROR_LABELS as directBuiltinSquadsErrorLabels,
  DEFAULT_SQUADS_ERROR_PLACEHOLDER as directDefaultSquadsErrorPlaceholder,
  normalizeStringifiedSquadsError as directNormalizeStringifiedSquadsError,
  stringifyUnknownSquadsError as directStringifyUnknownSquadsError,
} from './error-format.js';
import {
  getSquadsChains as directGetSquadsChains,
  getSquadsKeysForResolvedChain as directGetSquadsKeysForResolvedChain,
  resolveSquadsChainName as directResolveSquadsChainName,
  squadsConfigs as directSquadsConfigs,
} from './config.js';

const SDK_SQUADS_SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT_INDEX_PATH = path.resolve(
  SDK_SQUADS_SOURCE_DIR,
  '..',
  'index.ts',
);
const SQUADS_BARREL_INDEX_PATH = path.resolve(
  SDK_SQUADS_SOURCE_DIR,
  'index.ts',
);
const SDK_PACKAGE_ROOT = path.resolve(SDK_SQUADS_SOURCE_DIR, '..', '..');
const SDK_PACKAGE_JSON_PATH = path.resolve(
  SDK_SQUADS_SOURCE_DIR,
  '..',
  '..',
  'package.json',
);
const SDK_SQUADS_TEST_COMMAND_PREFIX = 'mocha --config .mocharc.json';
const SDK_SQUADS_TEST_GLOB = 'src/squads/*.test.ts';
const SDK_SQUADS_TEST_TOKEN_PATHS = Object.freeze([SDK_SQUADS_TEST_GLOB]);
const EXPECTED_SDK_SQUADS_TEST_FILE_PATHS = Object.freeze([
  'src/squads/config.test.ts',
  'src/squads/error-format.test.ts',
  'src/squads/index.test.ts',
  'src/squads/inspection.test.ts',
  'src/squads/provider.test.ts',
  'src/squads/transaction-reader.test.ts',
  'src/squads/utils.test.ts',
]);
const EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS =
  Object.freeze([
    'src/squads/config.test.ts',
    'src/squads/error-format.test.ts',
    'src/squads/inspection.test.ts',
    'src/squads/provider.test.ts',
    'src/squads/transaction-reader.test.ts',
    'src/squads/utils.test.ts',
  ]);
const EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS = Object.freeze([
  Object.freeze({
    testPath: 'src/squads/config.test.ts',
    expectedMutationTestCount: 1,
  }),
  Object.freeze({
    testPath: 'src/squads/error-format.test.ts',
    expectedMutationTestCount: 2,
  }),
  Object.freeze({
    testPath: 'src/squads/inspection.test.ts',
    expectedMutationTestCount: 1,
  }),
  Object.freeze({
    testPath: 'src/squads/provider.test.ts',
    expectedMutationTestCount: 1,
  }),
  Object.freeze({
    testPath: 'src/squads/transaction-reader.test.ts',
    expectedMutationTestCount: 2,
  }),
  Object.freeze({
    testPath: 'src/squads/utils.test.ts',
    expectedMutationTestCount: 2,
  }),
]);
const EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNT = 9;
const EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS =
  Object.freeze([
    'src/squads/config.ts',
    'src/squads/error-format.ts',
    'src/squads/transaction-reader.ts',
    'src/squads/utils.ts',
    'src/squads/validation.ts',
  ]);
const EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS =
  Object.freeze(['src/squads/inspection.ts', 'src/squads/provider.ts']);
const EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS =
  Object.freeze([
    Object.freeze({
      runtimeSourcePath: 'src/squads/config.ts',
      expectedReflectApplyIdentifierReferenceCount: 1,
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/error-format.ts',
      expectedReflectApplyIdentifierReferenceCount: 1,
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/inspection.ts',
      expectedReflectApplyIdentifierReferenceCount: 0,
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/provider.ts',
      expectedReflectApplyIdentifierReferenceCount: 0,
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/transaction-reader.ts',
      expectedReflectApplyIdentifierReferenceCount: 1,
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/utils.ts',
      expectedReflectApplyIdentifierReferenceCount: 1,
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/validation.ts',
      expectedReflectApplyIdentifierReferenceCount: 1,
    }),
  ]);
const EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS = Object.freeze([
  Object.freeze({
    runtimeSourcePath: 'src/squads/config.ts',
    expectedReflectApplyInvocationCount: 7,
  }),
  Object.freeze({
    runtimeSourcePath: 'src/squads/error-format.ts',
    expectedReflectApplyInvocationCount: 7,
  }),
  Object.freeze({
    runtimeSourcePath: 'src/squads/inspection.ts',
    expectedReflectApplyInvocationCount: 0,
  }),
  Object.freeze({
    runtimeSourcePath: 'src/squads/provider.ts',
    expectedReflectApplyInvocationCount: 0,
  }),
  Object.freeze({
    runtimeSourcePath: 'src/squads/transaction-reader.ts',
    expectedReflectApplyInvocationCount: 1,
  }),
  Object.freeze({
    runtimeSourcePath: 'src/squads/utils.ts',
    expectedReflectApplyInvocationCount: 1,
  }),
  Object.freeze({
    runtimeSourcePath: 'src/squads/validation.ts',
    expectedReflectApplyInvocationCount: 1,
  }),
]);
const EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS =
  Object.freeze([
    Object.freeze({
      runtimeSourcePath: 'src/squads/config.ts',
      expectedReflectApplyCaptureDeclarationCount: 1,
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/error-format.ts',
      expectedReflectApplyCaptureDeclarationCount: 1,
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/inspection.ts',
      expectedReflectApplyCaptureDeclarationCount: 0,
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/provider.ts',
      expectedReflectApplyCaptureDeclarationCount: 0,
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/transaction-reader.ts',
      expectedReflectApplyCaptureDeclarationCount: 1,
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/utils.ts',
      expectedReflectApplyCaptureDeclarationCount: 1,
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/validation.ts',
      expectedReflectApplyCaptureDeclarationCount: 1,
    }),
  ]);
const EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNT = 5;
const EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNT = 17;
const EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNT = 5;
const EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT = 5;
const EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_COUNT = 2;
const EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT = 7;
const EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_IDENTIFIER_REFERENCE_COUNT = 2;
const EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_INVOCATION_COUNT = 2;
const EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_CAPTURE_DECLARATION_COUNT = 2;
const EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE =
  Object.freeze([
    Object.freeze({
      runtimeSourcePath: 'src/squads/config.ts',
      coveringTestPaths: Object.freeze(['src/squads/config.test.ts']),
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/error-format.ts',
      coveringTestPaths: Object.freeze(['src/squads/error-format.test.ts']),
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/inspection.ts',
      coveringTestPaths: Object.freeze(['src/squads/inspection.test.ts']),
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/provider.ts',
      coveringTestPaths: Object.freeze(['src/squads/provider.test.ts']),
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/transaction-reader.ts',
      coveringTestPaths: Object.freeze([
        'src/squads/transaction-reader.test.ts',
      ]),
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/utils.ts',
      coveringTestPaths: Object.freeze(['src/squads/utils.test.ts']),
    }),
    Object.freeze({
      runtimeSourcePath: 'src/squads/validation.ts',
      coveringTestPaths: Object.freeze(['src/squads/utils.test.ts']),
    }),
  ]);
const REFLECT_APPLY_MUTATION_TEST_TITLE_PATTERN =
  /\bit\s*\(\s*['"`][^'"`]*Reflect\.apply is mutated[^'"`]*['"`]/;
const REFLECT_APPLY_MONKEY_PATCH_PATTERN =
  /Object\.defineProperty\(\s*Reflect\s*,\s*['"]apply['"]/;
const REFLECT_APPLY_CAPTURE_DECLARATION_PATTERN =
  /\bconst\s+REFLECT_APPLY\s*=\s*Reflect\.apply\b/;
const REFLECT_APPLY_IDENTIFIER_REFERENCE_STATEMENT = 'Reflect.apply';
const REFLECT_APPLY_INVOCATION_STATEMENT = 'REFLECT_APPLY(';
const REFLECT_APPLY_CAPTURE_DECLARATION_STATEMENT =
  'const REFLECT_APPLY = Reflect.apply as <';
const REFLECT_APPLY_MONKEY_PATCH_STATEMENT =
  "Object.defineProperty(Reflect, 'apply', {";
const REFLECT_APPLY_MUTATION_THROW_STATEMENT =
  "throw new Error('reflect apply unavailable');";
const REFLECT_APPLY_CAPTURE_STATEMENT =
  'const originalReflectApply = Reflect.apply;';
const REFLECT_APPLY_RESTORE_STATEMENT = 'value: originalReflectApply,';
const EXPECTED_SDK_SQUADS_TEST_SCRIPT = `${SDK_SQUADS_TEST_COMMAND_PREFIX} ${SDK_SQUADS_TEST_TOKEN_PATHS.map((tokenPath) => `'${tokenPath}'`).join(' ')}`;
const EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS = Object.freeze([
  "export * from './config.js';",
  "export * from './utils.js';",
  "export * from './transaction-reader.js';",
  "export * from './error-format.js';",
]);
const EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS = Object.freeze([
  'src/squads/config.ts',
  'src/squads/error-format.ts',
  'src/squads/transaction-reader.ts',
  'src/squads/utils.ts',
]);
const SDK_SQUADS_INDEX_SOURCE_PATH = 'src/squads/index.ts';
const EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS = Object.freeze([
  'src/squads/inspection.ts',
  'src/squads/provider.ts',
  'src/squads/validation.ts',
]);
const INFRA_REFERENCE_PATTERN =
  /(?:@hyperlane-xyz\/infra|typescript\/infra|(?:\.\.\/)+infra\/)/;
const FILESYSTEM_IMPORT_PATTERN =
  /(?:from\s+['"](?:node:)?(?:fs|path)(?:\/[^'"]*)?['"]|import\(\s*['"](?:node:)?(?:fs|path)(?:\/[^'"]*)?['"]\s*\)|require\(\s*['"](?:node:)?(?:fs|path)(?:\/[^'"]*)?['"]\s*\))/;
const PROCESS_ENV_REFERENCE_PATTERN = /\bprocess\.env\b/;
const PROCESS_ARGV_REFERENCE_PATTERN = /\bprocess\.argv\b/;
const PROCESS_CWD_REFERENCE_PATTERN = /\bprocess\.cwd\s*\(/;
const PROCESS_EXIT_REFERENCE_PATTERN = /\bprocess\.exit\s*\(/;
const PROCESS_STDIN_REFERENCE_PATTERN = /\bprocess\.stdin\b/;
const PROCESS_STDOUT_REFERENCE_PATTERN = /\bprocess\.stdout\b/;
const PROCESS_STDERR_REFERENCE_PATTERN = /\bprocess\.stderr\b/;
const PROCESS_BRACKET_REFERENCE_PATTERN =
  /\bprocess\s*\[\s*['"](?:env|argv|cwd|exit|stdin|stdout|stderr)['"]\s*\](?:\s*\(|\b)/;
const PROCESS_DESTRUCTURE_REFERENCE_PATTERN =
  /\{[^}]*\b(?:env|argv|cwd|exit|stdin|stdout|stderr)\b[^}]*\}\s*=\s*process\b/;
const PROCESS_ALIAS_REFERENCE_PATTERN =
  /\b(?:const|let|var)\s+\w+\s*=\s*process\b/;
const PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN =
  /\bprocess\s*\?\.\s*(?:(?:env|argv|cwd|exit|stdin|stdout|stderr)\b|\[\s*['"](?:env|argv|cwd|exit|stdin|stdout|stderr)['"]\s*\])/;
const PARENTHESIZED_PROCESS_REFERENCE_PATTERN =
  /\(\s*process\s*\)\s*(?:\.\s*(?:env|argv|cwd|exit|stdin|stdout|stderr)\b|\[\s*['"](?:env|argv|cwd|exit|stdin|stdout|stderr)['"]\s*\])/;
const PARENTHESIZED_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN =
  /\(\s*process\s*\)\s*\?\.\s*(?:(?:env|argv|cwd|exit|stdin|stdout|stderr)\b|\[\s*['"](?:env|argv|cwd|exit|stdin|stdout|stderr)['"]\s*\])/;
const GLOBAL_PROCESS_REFERENCE_PATTERN =
  /\b(?:globalThis|global)\s*\.\s*process\b/;
const GLOBAL_PROCESS_BRACKET_REFERENCE_PATTERN =
  /\b(?:globalThis|global)\s*\[\s*['"]process['"]\s*\]/;
const GLOBAL_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN =
  /\b(?:globalThis|global|window)\s*\?\.\s*(?:process\b|\[\s*['"]process['"]\s*\])/;
const PARENTHESIZED_GLOBAL_PROCESS_REFERENCE_PATTERN =
  /\(\s*(?:globalThis|global|window)\s*\)\s*(?:\.\s*process\b|\[\s*['"]process['"]\s*\])/;
const PARENTHESIZED_GLOBAL_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN =
  /\(\s*(?:globalThis|global|window|self)\s*\)\s*\?\.\s*(?:process\b|\[\s*['"]process['"]\s*\])/;
const WINDOW_PROCESS_REFERENCE_PATTERN = /\bwindow\s*\.\s*process\b/;
const WINDOW_PROCESS_BRACKET_REFERENCE_PATTERN =
  /\bwindow\s*\[\s*['"]process['"]\s*\]/;
const SELF_PROCESS_REFERENCE_PATTERN = /\bself\s*\.\s*process\b/;
const SELF_PROCESS_BRACKET_REFERENCE_PATTERN =
  /\bself\s*\[\s*['"]process['"]\s*\]/;
const SELF_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN =
  /\bself\s*\?\.\s*(?:process\b|\[\s*['"]process['"]\s*\])/;
const PARENTHESIZED_SELF_PROCESS_REFERENCE_PATTERN =
  /\(\s*self\s*\)\s*(?:\.\s*process\b|\[\s*['"]process['"]\s*\])/;
const PARENTHESIZED_SELF_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN =
  /\(\s*self\s*\)\s*\?\.\s*(?:process\b|\[\s*['"]process['"]\s*\])/;
const GLOBAL_PROCESS_DESTRUCTURE_REFERENCE_PATTERN =
  /\{[^}]*\bprocess\b[^}]*\}\s*=\s*(?:globalThis|global|window|self)\b/;
const CONSOLE_REFERENCE_PATTERN =
  /\bconsole\s*(?:\.\s*(?:log|info|warn|error|debug|trace|table)\s*\(|\[\s*['"](?:log|info|warn|error|debug|trace|table)['"]\s*\]\s*\()/;
const CONSOLE_DESTRUCTURE_REFERENCE_PATTERN =
  /\{[^}]*\b(?:log|info|warn|error|debug|trace|table)\b[^}]*\}\s*=\s*console\b/;
const CONSOLE_ALIAS_REFERENCE_PATTERN =
  /\b(?:const|let|var)\s+\w+\s*=\s*console\b/;
const CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN =
  /\bconsole\s*\?\.\s*(?:(?:log|info|warn|error|debug|trace|table)\s*\(|\[\s*['"](?:log|info|warn|error|debug|trace|table)['"]\s*\]\s*\()/;
const PARENTHESIZED_CONSOLE_REFERENCE_PATTERN =
  /\(\s*console\s*\)\s*(?:\.\s*(?:log|info|warn|error|debug|trace|table)\s*\(|\[\s*['"](?:log|info|warn|error|debug|trace|table)['"]\s*\]\s*\()/;
const PARENTHESIZED_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN =
  /\(\s*console\s*\)\s*\?\.\s*(?:(?:log|info|warn|error|debug|trace|table)\s*\(|\[\s*['"](?:log|info|warn|error|debug|trace|table)['"]\s*\]\s*\()/;
const GLOBAL_CONSOLE_REFERENCE_PATTERN =
  /\b(?:globalThis|global)\s*\.\s*console\b/;
const GLOBAL_CONSOLE_BRACKET_REFERENCE_PATTERN =
  /\b(?:globalThis|global)\s*\[\s*['"]console['"]\s*\]/;
const GLOBAL_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN =
  /\b(?:globalThis|global|window)\s*\?\.\s*(?:console\b|\[\s*['"]console['"]\s*\])/;
const PARENTHESIZED_GLOBAL_CONSOLE_REFERENCE_PATTERN =
  /\(\s*(?:globalThis|global|window)\s*\)\s*(?:\.\s*console\b|\[\s*['"]console['"]\s*\])/;
const PARENTHESIZED_GLOBAL_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN =
  /\(\s*(?:globalThis|global|window|self)\s*\)\s*\?\.\s*(?:console\b|\[\s*['"]console['"]\s*\])/;
const WINDOW_CONSOLE_REFERENCE_PATTERN = /\bwindow\s*\.\s*console\b/;
const WINDOW_CONSOLE_BRACKET_REFERENCE_PATTERN =
  /\bwindow\s*\[\s*['"]console['"]\s*\]/;
const SELF_CONSOLE_REFERENCE_PATTERN = /\bself\s*\.\s*console\b/;
const SELF_CONSOLE_BRACKET_REFERENCE_PATTERN =
  /\bself\s*\[\s*['"]console['"]\s*\]/;
const SELF_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN =
  /\bself\s*\?\.\s*(?:console\b|\[\s*['"]console['"]\s*\])/;
const PARENTHESIZED_SELF_CONSOLE_REFERENCE_PATTERN =
  /\(\s*self\s*\)\s*(?:\.\s*console\b|\[\s*['"]console['"]\s*\])/;
const PARENTHESIZED_SELF_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN =
  /\(\s*self\s*\)\s*\?\.\s*(?:console\b|\[\s*['"]console['"]\s*\])/;
const GLOBAL_CONSOLE_DESTRUCTURE_REFERENCE_PATTERN =
  /\{[^}]*\bconsole\b[^}]*\}\s*=\s*(?:globalThis|global|window|self)\b/;
const CLI_GLUE_IMPORT_PATTERN =
  /(?:from\s+['"](?:yargs|chalk|@inquirer\/prompts|cli-table3)['"]|import\(\s*['"](?:yargs|chalk|@inquirer\/prompts|cli-table3)['"]\s*\)|require\(\s*['"](?:yargs|chalk|@inquirer\/prompts|cli-table3)['"]\s*\))/;
const FORBIDDEN_RUNTIME_HARDENING_PATTERNS = Object.freeze([
  Object.freeze({
    label: 'inline cast-property access',
    pattern: /\([^)\n]*\sas\s\{[^\n]*\}\)\.[A-Za-z0-9_]+/,
  }),
  Object.freeze({
    label: 'optional chaining',
    pattern: /\?\./,
  }),
  Object.freeze({
    label: 'Object.keys call',
    pattern: /\bObject\.keys\s*\(/,
  }),
  Object.freeze({
    label: 'Object.values call',
    pattern: /\bObject\.values\s*\(/,
  }),
  Object.freeze({
    label: 'Object.entries call',
    pattern: /\bObject\.entries\s*\(/,
  }),
  Object.freeze({
    label: 'Object.freeze call',
    pattern: /\bObject\.freeze\s*\(/,
  }),
  Object.freeze({
    label: 'Object.prototype.toString.call call',
    pattern: /\bObject\.prototype\.toString\.call\s*\(/,
  }),
  Object.freeze({
    label: 'Object.fromEntries call',
    pattern: /\bObject\.fromEntries\s*\(/,
  }),
  Object.freeze({
    label: 'Object.assign call',
    pattern: /\bObject\.assign\s*\(/,
  }),
  Object.freeze({
    label: 'Object.getOwnPropertyNames call',
    pattern: /\bObject\.getOwnPropertyNames\s*\(/,
  }),
  Object.freeze({
    label: 'Object.getOwnPropertySymbols call',
    pattern: /\bObject\.getOwnPropertySymbols\s*\(/,
  }),
  Object.freeze({
    label: 'Object.hasOwn call',
    pattern: /\bObject\.hasOwn\s*\(/,
  }),
  Object.freeze({
    label: 'Object.create call',
    pattern: /\bObject\.create\s*\(/,
  }),
  Object.freeze({
    label: 'Object.defineProperty call',
    pattern: /\bObject\.defineProperty\s*\(/,
  }),
  Object.freeze({
    label: 'Object.getPrototypeOf call',
    pattern: /\bObject\.getPrototypeOf\s*\(/,
  }),
  Object.freeze({
    label: 'Object.setPrototypeOf call',
    pattern: /\bObject\.setPrototypeOf\s*\(/,
  }),
  Object.freeze({
    label: 'Reflect.ownKeys call',
    pattern: /\bReflect\.ownKeys\s*\(/,
  }),
  Object.freeze({
    label: 'Reflect.get call',
    pattern: /\bReflect\.get\s*\(/,
  }),
  Object.freeze({
    label: 'Reflect.set call',
    pattern: /\bReflect\.set\s*\(/,
  }),
  Object.freeze({
    label: 'Reflect.has call',
    pattern: /\bReflect\.has\s*\(/,
  }),
  Object.freeze({
    label: 'Reflect.deleteProperty call',
    pattern: /\bReflect\.deleteProperty\s*\(/,
  }),
  Object.freeze({
    label: 'Reflect.apply call',
    pattern: /\bReflect\.apply\s*\(/,
  }),
  Object.freeze({
    label: 'Array.from call',
    pattern: /\bArray\.from\s*\(/,
  }),
  Object.freeze({
    label: 'Array.isArray call',
    pattern: /\bArray\.isArray\s*\(/,
  }),
  Object.freeze({
    label: 'Buffer.isBuffer call',
    pattern: /\bBuffer\.isBuffer\s*\(/,
  }),
  Object.freeze({
    label: 'Buffer.from call',
    pattern: /\bBuffer\.from\s*\(/,
  }),
  Object.freeze({
    label: 'Buffer.alloc call',
    pattern: /\bBuffer\.alloc\s*\(/,
  }),
  Object.freeze({
    label: 'Number.isSafeInteger call',
    pattern: /\bNumber\.isSafeInteger\s*\(/,
  }),
  Object.freeze({
    label: 'Number.isInteger call',
    pattern: /\bNumber\.isInteger\s*\(/,
  }),
  Object.freeze({
    label: 'Number.isFinite call',
    pattern: /\bNumber\.isFinite\s*\(/,
  }),
  Object.freeze({
    label: 'Number.isNaN call',
    pattern: /\bNumber\.isNaN\s*\(/,
  }),
  Object.freeze({
    label: 'Promise.all call',
    pattern: /\bPromise\.all\s*\(/,
  }),
  Object.freeze({
    label: 'String call',
    pattern: /\bString\s*\(/,
  }),
  Object.freeze({
    label: 'Boolean call',
    pattern: /\bBoolean\s*\(/,
  }),
  Object.freeze({
    label: 'BigInt call',
    pattern: /\bBigInt\s*\(/,
  }),
  Object.freeze({
    label: 'Number call',
    pattern: /\bNumber\s*\(/,
  }),
  Object.freeze({
    label: 'Number.NaN access',
    pattern: /\bNumber\.NaN\b/,
  }),
  Object.freeze({
    label: 'Math.max call',
    pattern: /\bMath\.max\s*\(/,
  }),
  Object.freeze({
    label: 'new Date call',
    pattern: /\bnew\s+Date\s*\(/,
  }),
  Object.freeze({
    label: 'new Set call',
    pattern: /\bnew\s+Set\s*(?:<[^>\n]*>)?\s*\(/,
  }),
  Object.freeze({
    label: 'new Map call',
    pattern: /\bnew\s+Map\s*(?:<[^>\n]*>)?\s*\(/,
  }),
  Object.freeze({
    label: 'new Error call',
    pattern: /\bnew\s+Error\s*\(/,
  }),
  Object.freeze({
    label: '.entries method call',
    pattern: /\.entries\s*\(/,
  }),
  Object.freeze({
    label: '.keys method call',
    pattern: /\.keys\s*\(/,
  }),
  Object.freeze({
    label: '.values method call',
    pattern: /\.values\s*\(/,
  }),
  Object.freeze({
    label: '.has method call',
    pattern: /\.has\s*\(/,
  }),
  Object.freeze({
    label: '.add method call',
    pattern: /\.add\s*\(/,
  }),
  Object.freeze({
    label: '.get method call',
    pattern: /\.get\s*\(/,
  }),
  Object.freeze({
    label: '.set method call',
    pattern: /\.set\s*\(/,
  }),
  Object.freeze({
    label: '.bind method call',
    pattern: /\.bind\s*\(/,
  }),
  Object.freeze({
    label: '.apply method call',
    pattern: /\.apply\s*\(/,
  }),
  Object.freeze({
    label: '.clear method call',
    pattern: /\.clear\s*\(/,
  }),
  Object.freeze({
    label: '.delete method call',
    pattern: /\.delete\s*\(/,
  }),
  Object.freeze({
    label: '.includes method call',
    pattern: /\.includes\s*\(/,
  }),
  Object.freeze({
    label: '.startsWith method call',
    pattern: /\.startsWith\s*\(/,
  }),
  Object.freeze({
    label: '.endsWith method call',
    pattern: /\.endsWith\s*\(/,
  }),
  Object.freeze({
    label: '.indexOf method call',
    pattern: /\.indexOf\s*\(/,
  }),
  Object.freeze({
    label: '.some method call',
    pattern: /\.some\s*\(/,
  }),
  Object.freeze({
    label: '.forEach method call',
    pattern: /\.forEach\s*\(/,
  }),
  Object.freeze({
    label: '.every method call',
    pattern: /\.every\s*\(/,
  }),
  Object.freeze({
    label: '.find method call',
    pattern: /\.find\s*\(/,
  }),
  Object.freeze({
    label: '.findIndex method call',
    pattern: /\.findIndex\s*\(/,
  }),
  Object.freeze({
    label: '.concat method call',
    pattern: /\.concat\s*\(/,
  }),
  Object.freeze({
    label: '.reduce method call',
    pattern: /\.reduce\s*\(/,
  }),
  Object.freeze({
    label: '.flat method call',
    pattern: /\.flat\s*\(/,
  }),
  Object.freeze({
    label: '.flatMap method call',
    pattern: /\.flatMap\s*\(/,
  }),
  Object.freeze({
    label: '.at method call',
    pattern: /\.at\s*\(/,
  }),
  Object.freeze({
    label: '.pop method call',
    pattern: /\.pop\s*\(/,
  }),
  Object.freeze({
    label: '.shift method call',
    pattern: /\.shift\s*\(/,
  }),
  Object.freeze({
    label: '.unshift method call',
    pattern: /\.unshift\s*\(/,
  }),
  Object.freeze({
    label: '.splice method call',
    pattern: /\.splice\s*\(/,
  }),
  Object.freeze({
    label: '.reverse method call',
    pattern: /\.reverse\s*\(/,
  }),
  Object.freeze({
    label: '.toSorted method call',
    pattern: /\.toSorted\s*\(/,
  }),
  Object.freeze({
    label: '.toReversed method call',
    pattern: /\.toReversed\s*\(/,
  }),
  Object.freeze({
    label: '.toSpliced method call',
    pattern: /\.toSpliced\s*\(/,
  }),
  Object.freeze({
    label: '.with method call',
    pattern: /\.with\s*\(/,
  }),
  Object.freeze({
    label: '.match method call',
    pattern: /\.match\s*\(/,
  }),
  Object.freeze({
    label: '.search method call',
    pattern: /\.search\s*\(/,
  }),
  Object.freeze({
    label: '.test method call',
    pattern: /\.test\s*\(/,
  }),
  Object.freeze({
    label: '.exec method call',
    pattern: /\.exec\s*\(/,
  }),
  Object.freeze({
    label: '.substring method call',
    pattern: /\.substring\s*\(/,
  }),
  Object.freeze({
    label: '.charAt method call',
    pattern: /\.charAt\s*\(/,
  }),
  Object.freeze({
    label: '.charCodeAt method call',
    pattern: /\.charCodeAt\s*\(/,
  }),
  Object.freeze({
    label: '.trim method call',
    pattern: /\.trim\s*\(/,
  }),
  Object.freeze({
    label: '.trimStart method call',
    pattern: /\.trimStart\s*\(/,
  }),
  Object.freeze({
    label: '.trimEnd method call',
    pattern: /\.trimEnd\s*\(/,
  }),
  Object.freeze({
    label: '.toLowerCase method call',
    pattern: /\.toLowerCase\s*\(/,
  }),
  Object.freeze({
    label: '.toLocaleLowerCase method call',
    pattern: /\.toLocaleLowerCase\s*\(/,
  }),
  Object.freeze({
    label: '.toUpperCase method call',
    pattern: /\.toUpperCase\s*\(/,
  }),
  Object.freeze({
    label: '.toLocaleUpperCase method call',
    pattern: /\.toLocaleUpperCase\s*\(/,
  }),
  Object.freeze({
    label: '.normalize method call',
    pattern: /\.normalize\s*\(/,
  }),
  Object.freeze({
    label: '.padStart method call',
    pattern: /\.padStart\s*\(/,
  }),
  Object.freeze({
    label: '.padEnd method call',
    pattern: /\.padEnd\s*\(/,
  }),
  Object.freeze({
    label: '.repeat method call',
    pattern: /\.repeat\s*\(/,
  }),
  Object.freeze({
    label: '.map method call',
    pattern: /\.map\s*\(/,
  }),
  Object.freeze({
    label: '.filter method call',
    pattern: /\.filter\s*\(/,
  }),
  Object.freeze({
    label: '.join method call',
    pattern: /\.join\s*\(/,
  }),
  Object.freeze({
    label: '.split method call',
    pattern: /\.split\s*\(/,
  }),
  Object.freeze({
    label: '.replace method call',
    pattern: /\.replace\s*\(/,
  }),
  Object.freeze({
    label: '.call method call',
    pattern: /\.call\s*\(/,
  }),
  Object.freeze({
    label: '.toString method call',
    pattern: /\.toString\s*\(/,
  }),
  Object.freeze({
    label: '.toDateString method call',
    pattern: /\.toDateString\s*\(/,
  }),
  Object.freeze({
    label: '.subarray method call',
    pattern: /\.subarray\s*\(/,
  }),
  Object.freeze({
    label: '.slice method call',
    pattern: /\.slice\s*\(/,
  }),
  Object.freeze({
    label: '.localeCompare method call',
    pattern: /\.localeCompare\s*\(/,
  }),
  Object.freeze({
    label: '.push method call',
    pattern: /\.push\s*\(/,
  }),
  Object.freeze({
    label: '.sort method call',
    pattern: /\.sort\s*\(/,
  }),
  Object.freeze({
    label: '.fill method call',
    pattern: /\.fill\s*\(/,
  }),
  Object.freeze({
    label: '.copyWithin method call',
    pattern: /\.copyWithin\s*\(/,
  }),
]);
const REQUIRED_FORBIDDEN_RUNTIME_HARDENING_PATTERN_LABELS = Object.freeze([
  'inline cast-property access',
  'optional chaining',
  'Object.keys call',
  'Object.values call',
  'Object.entries call',
  'Object.freeze call',
  'Object.prototype.toString.call call',
  'Object.fromEntries call',
  'Object.assign call',
  'Object.getOwnPropertyNames call',
  'Object.getOwnPropertySymbols call',
  'Object.hasOwn call',
  'Object.create call',
  'Object.defineProperty call',
  'Object.getPrototypeOf call',
  'Object.setPrototypeOf call',
  'Reflect.ownKeys call',
  'Reflect.get call',
  'Reflect.set call',
  'Reflect.has call',
  'Reflect.deleteProperty call',
  'Reflect.apply call',
  'Array.from call',
  'Array.isArray call',
  'Buffer.isBuffer call',
  'Buffer.from call',
  'Buffer.alloc call',
  'Number.isSafeInteger call',
  'Number.isInteger call',
  'Number.isFinite call',
  'Number.isNaN call',
  'Promise.all call',
  'String call',
  'Boolean call',
  'BigInt call',
  'Number call',
  'Number.NaN access',
  'Math.max call',
  'new Date call',
  'new Set call',
  'new Map call',
  'new Error call',
  '.entries method call',
  '.keys method call',
  '.values method call',
  '.has method call',
  '.add method call',
  '.get method call',
  '.set method call',
  '.bind method call',
  '.apply method call',
  '.clear method call',
  '.delete method call',
  '.includes method call',
  '.some method call',
  '.trim method call',
  '.trimStart method call',
  '.trimEnd method call',
  '.toLowerCase method call',
  '.toLocaleLowerCase method call',
  '.toUpperCase method call',
  '.toLocaleUpperCase method call',
  '.normalize method call',
  '.padStart method call',
  '.padEnd method call',
  '.repeat method call',
  '.map method call',
  '.filter method call',
  '.join method call',
  '.split method call',
  '.replace method call',
  '.call method call',
  '.test method call',
  '.exec method call',
  '.toString method call',
  '.toDateString method call',
  '.subarray method call',
  '.slice method call',
  '.push method call',
  '.sort method call',
  '.fill method call',
  '.copyWithin method call',
  '.toReversed method call',
  '.toSpliced method call',
  '.with method call',
]);
const EXPECTED_FORBIDDEN_RUNTIME_HARDENING_PATTERN_COUNT = 109;
const EXPECTED_REQUIRED_FORBIDDEN_RUNTIME_HARDENING_LABEL_COUNT = 85;
const SINGLE_QUOTED_SCRIPT_TOKEN_PATTERN = /'([^']+)'/g;
function compareLexicographically(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

type RuntimeReflectApplyCountSummary = Readonly<{
  runtimeSourcePath: string;
  reflectApplyIdentifierReferenceCount: number;
  reflectApplyInvocationCount: number;
  reflectApplyCaptureDeclarationCount: number;
}>;

function listSdkSquadsRuntimeReflectApplyCountSummaries(): readonly RuntimeReflectApplyCountSummary[] {
  const summaries: RuntimeReflectApplyCountSummary[] = [];
  for (const runtimeSourcePath of listSdkSquadsNonTestSourceFilePaths()
    .filter((sourcePath) => sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH)
    .sort(compareLexicographically)) {
    const absoluteSourcePath = path.join(SDK_PACKAGE_ROOT, runtimeSourcePath);
    const source = fs.readFileSync(absoluteSourcePath, 'utf8');
    summaries.push(
      Object.freeze({
        runtimeSourcePath,
        reflectApplyIdentifierReferenceCount: countOccurrences(
          source,
          REFLECT_APPLY_IDENTIFIER_REFERENCE_STATEMENT,
        ),
        reflectApplyInvocationCount: countOccurrences(
          source,
          REFLECT_APPLY_INVOCATION_STATEMENT,
        ),
        reflectApplyCaptureDeclarationCount: countOccurrences(
          source,
          REFLECT_APPLY_CAPTURE_DECLARATION_STATEMENT,
        ),
      }),
    );
  }
  return Object.freeze(summaries);
}

function listSingleQuotedTokens(command: string): readonly string[] {
  return [...command.matchAll(SINGLE_QUOTED_SCRIPT_TOKEN_PATTERN)].map(
    (match) => match[1],
  );
}

function getQuotedSdkSquadsTestTokens(): readonly string[] {
  return listSingleQuotedTokens(EXPECTED_SDK_SQUADS_TEST_SCRIPT);
}

function assertCanonicalCliCommandShape(
  command: string,
  commandLabel: string,
): void {
  expect(command, `Expected ${commandLabel} to be trimmed`).to.equal(
    command.trim(),
  );
  expect(
    command.includes('  '),
    `Expected ${commandLabel} to avoid duplicate spaces`,
  ).to.equal(false);
  expect(
    /[\n\r\t]/.test(command),
    `Expected ${commandLabel} to be single-line without tab/newline characters`,
  ).to.equal(false);
  expect(
    command.includes('\\'),
    `Expected ${commandLabel} to avoid backslash separators`,
  ).to.equal(false);
}

function assertSdkSquadsTestTokenShape(
  token: string,
  tokenLabel: string,
): void {
  expect(
    token.startsWith('src/'),
    `Expected ${tokenLabel} to start with src/: ${token}`,
  ).to.equal(true);
  expect(
    token.startsWith('test/'),
    `Expected ${tokenLabel} to avoid test/ prefix: ${token}`,
  ).to.equal(false);
  expect(
    token.startsWith('/'),
    `Expected ${tokenLabel} to be relative: ${token}`,
  ).to.equal(false);
  expect(
    token.includes('..'),
    `Expected ${tokenLabel} to avoid parent traversal: ${token}`,
  ).to.equal(false);
  expect(
    token.includes('\\'),
    `Expected ${tokenLabel} to avoid backslash separators: ${token}`,
  ).to.equal(false);
  expect(token, `Expected ${tokenLabel} to be trimmed: ${token}`).to.equal(
    token.trim(),
  );
  expect(
    /\s/.test(token),
    `Expected ${tokenLabel} to avoid whitespace characters: ${token}`,
  ).to.equal(false);
  expect(
    token,
    `Expected ${tokenLabel} to remain normalized: ${token}`,
  ).to.equal(path.posix.normalize(token));
  expect(
    token.includes('/squads/'),
    `Expected ${tokenLabel} to stay squads-scoped: ${token}`,
  ).to.equal(true);
  expect(
    token.endsWith('.test.ts'),
    `Expected ${tokenLabel} to stay test-file scoped: ${token}`,
  ).to.equal(true);
}

function assertSdkSquadsNonTestSourcePathShape(
  sourcePath: string,
  sourcePathLabel: string,
): void {
  expect(
    sourcePath.startsWith('src/'),
    `Expected ${sourcePathLabel} to start with src/: ${sourcePath}`,
  ).to.equal(true);
  expect(
    sourcePath.includes('/squads/'),
    `Expected ${sourcePathLabel} to stay squads-scoped: ${sourcePath}`,
  ).to.equal(true);
  expect(
    sourcePath.endsWith('.ts'),
    `Expected ${sourcePathLabel} to end with .ts: ${sourcePath}`,
  ).to.equal(true);
  expect(
    sourcePath.endsWith('.test.ts'),
    `Expected ${sourcePathLabel} to remain non-test scoped: ${sourcePath}`,
  ).to.equal(false);
  expect(
    sourcePath.startsWith('/'),
    `Expected ${sourcePathLabel} to be relative: ${sourcePath}`,
  ).to.equal(false);
  expect(
    sourcePath.includes('..'),
    `Expected ${sourcePathLabel} to avoid parent traversal: ${sourcePath}`,
  ).to.equal(false);
  expect(
    sourcePath.includes('\\'),
    `Expected ${sourcePathLabel} to avoid backslash separators: ${sourcePath}`,
  ).to.equal(false);
  expect(
    /\s/.test(sourcePath),
    `Expected ${sourcePathLabel} to avoid whitespace characters: ${sourcePath}`,
  ).to.equal(false);
  expect(
    sourcePath,
    `Expected ${sourcePathLabel} to remain normalized: ${sourcePath}`,
  ).to.equal(path.posix.normalize(sourcePath));
}

function assertSingleAsteriskGlobShape(
  globPattern: string,
  globLabel: string,
): void {
  expect(globPattern, `Expected ${globLabel} to be trimmed`).to.equal(
    globPattern.trim(),
  );
  expect(
    globPattern.includes('\\'),
    `Expected ${globLabel} to avoid backslash separators: ${globPattern}`,
  ).to.equal(false);
  expect(
    /\s/.test(globPattern),
    `Expected ${globLabel} to avoid whitespace characters: ${globPattern}`,
  ).to.equal(false);
  const wildcardIndex = globPattern.indexOf('*');
  expect(
    wildcardIndex,
    `Expected ${globLabel} to include wildcard segment: ${globPattern}`,
  ).to.not.equal(-1);
  expect(
    globPattern.indexOf('*', wildcardIndex + 1),
    `Expected ${globLabel} to include a single wildcard segment: ${globPattern}`,
  ).to.equal(-1);
  const prefix = globPattern.slice(0, wildcardIndex);
  const suffix = globPattern.slice(wildcardIndex + 1);
  expect(
    prefix.startsWith('src/'),
    `Expected ${globLabel} prefix to stay src-scoped: ${globPattern}`,
  ).to.equal(true);
  expect(
    prefix.includes('/squads/'),
    `Expected ${globLabel} prefix to stay squads-scoped: ${globPattern}`,
  ).to.equal(true);
  expect(
    suffix.endsWith('.test.ts'),
    `Expected ${globLabel} suffix to remain test-file scoped: ${globPattern}`,
  ).to.equal(true);
}

function assertSdkSquadsTokenPathSetNormalizedAndDeduplicated(
  tokenPaths: readonly string[],
  tokenSetLabel: string,
): void {
  expect(tokenPaths).to.deep.equal(
    [...tokenPaths].sort(compareLexicographically),
  );
  expect(new Set(tokenPaths).size).to.equal(tokenPaths.length);
  for (const tokenPath of tokenPaths) {
    assertSdkSquadsTestTokenShape(tokenPath, `${tokenSetLabel} token path`);
  }
}

function assertSdkQuotedCommandTokenSet(
  tokenPaths: readonly string[],
  tokenSetLabel: string,
): void {
  expect(tokenPaths).to.deep.equal([...SDK_SQUADS_TEST_TOKEN_PATHS]);
  assertSdkSquadsTokenPathSetNormalizedAndDeduplicated(
    tokenPaths,
    tokenSetLabel,
  );
  for (const tokenPath of tokenPaths) {
    expect(
      countOccurrences(EXPECTED_SDK_SQUADS_TEST_SCRIPT, `'${tokenPath}'`),
      `Expected ${tokenSetLabel} token path to appear exactly once in command: ${tokenPath}`,
    ).to.equal(1);
  }
}

function listSdkSquadsDirectoryEntries(
  absoluteDirectoryPath: string,
): readonly fs.Dirent[] {
  return fs
    .readdirSync(absoluteDirectoryPath, { withFileTypes: true })
    .sort((left, right) => compareLexicographically(left.name, right.name));
}

function listSdkSquadsSubdirectoryPathsRecursively(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string = '',
): readonly string[] {
  const discoveredSubdirectories: string[] = [];
  for (const entry of listSdkSquadsDirectoryEntries(absoluteDirectoryPath)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const nextRelativePath =
      relativeDirectoryPath.length === 0
        ? entry.name
        : path.posix.join(relativeDirectoryPath, entry.name);
    const nextAbsolutePath = path.join(absoluteDirectoryPath, entry.name);
    discoveredSubdirectories.push(`src/squads/${nextRelativePath}`);
    discoveredSubdirectories.push(
      ...listSdkSquadsSubdirectoryPathsRecursively(
        nextAbsolutePath,
        nextRelativePath,
      ),
    );
  }
  return discoveredSubdirectories.sort(compareLexicographically);
}

function listSdkSquadsTestFilePaths(): readonly string[] {
  return listSdkSquadsDirectoryEntries(SDK_SQUADS_SOURCE_DIR)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => `src/squads/${entry.name}`);
}

function listSdkSquadsTestFilePathsContainingPattern(
  pattern: RegExp,
): readonly string[] {
  const matchedPaths: string[] = [];
  for (const relativeTestPath of listSdkSquadsTestFilePaths()) {
    const absoluteTestPath = path.join(SDK_PACKAGE_ROOT, relativeTestPath);
    const source = fs.readFileSync(absoluteTestPath, 'utf8');
    if (doesPatternMatchSource(source, pattern)) {
      matchedPaths.push(relativeTestPath);
    }
  }
  return matchedPaths.sort(compareLexicographically);
}

function listSdkSquadsNonTestSourceFilePathsContainingPattern(
  pattern: RegExp,
): readonly string[] {
  const matchedPaths: string[] = [];
  for (const relativeSourcePath of listSdkSquadsNonTestSourceFilePaths()) {
    const absoluteSourcePath = path.join(SDK_PACKAGE_ROOT, relativeSourcePath);
    const source = fs.readFileSync(absoluteSourcePath, 'utf8');
    if (doesPatternMatchSource(source, pattern)) {
      matchedPaths.push(relativeSourcePath);
    }
  }
  return matchedPaths.sort(compareLexicographically);
}

function doesPatternMatchSource(source: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  return pattern.test(source);
}

function listSdkSquadsNonTestSourceFilePaths(): readonly string[] {
  return listSdkSquadsDirectoryEntries(SDK_SQUADS_SOURCE_DIR)
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => `src/squads/${entry.name}`);
}

function listSdkSquadsTestFilePathsRecursively(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string = '',
): readonly string[] {
  return listSdkSquadsPathsRecursively(
    absoluteDirectoryPath,
    relativeDirectoryPath,
    (entryName) => entryName.endsWith('.test.ts'),
  );
}

function listSdkSquadsNonTestSourceFilePathsRecursively(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string = '',
): readonly string[] {
  return listSdkSquadsPathsRecursively(
    absoluteDirectoryPath,
    relativeDirectoryPath,
    (entryName) => entryName.endsWith('.ts') && !entryName.endsWith('.test.ts'),
  );
}

function listSdkSquadsTypeScriptPathsRecursively(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string = '',
): readonly string[] {
  return listSdkSquadsPathsRecursively(
    absoluteDirectoryPath,
    relativeDirectoryPath,
    (entryName) => entryName.endsWith('.ts'),
  );
}

function listSdkSquadsPathsRecursively(
  absoluteDirectoryPath: string,
  relativeDirectoryPath: string,
  shouldIncludeFileName: (entryName: string) => boolean,
): readonly string[] {
  const discoveredPaths: string[] = [];

  for (const entry of listSdkSquadsDirectoryEntries(absoluteDirectoryPath)) {
    const nextRelativePath =
      relativeDirectoryPath.length === 0
        ? entry.name
        : path.posix.join(relativeDirectoryPath, entry.name);
    const nextAbsolutePath = path.join(absoluteDirectoryPath, entry.name);

    if (entry.isDirectory()) {
      discoveredPaths.push(
        ...listSdkSquadsPathsRecursively(
          nextAbsolutePath,
          nextRelativePath,
          shouldIncludeFileName,
        ),
      );
      continue;
    }

    if (entry.isFile() && shouldIncludeFileName(entry.name)) {
      discoveredPaths.push(`src/squads/${nextRelativePath}`);
    }
  }

  return discoveredPaths.sort(compareLexicographically);
}

function matchesSingleAsteriskGlob(
  candidatePath: string,
  globPattern: string,
): boolean {
  const wildcardIndex = globPattern.indexOf('*');
  expect(
    wildcardIndex,
    `Expected sdk squads test glob to contain wildcard: ${globPattern}`,
  ).to.not.equal(-1);
  expect(
    globPattern.indexOf('*', wildcardIndex + 1),
    `Expected sdk squads test glob to contain a single wildcard: ${globPattern}`,
  ).to.equal(-1);

  const prefix = globPattern.slice(0, wildcardIndex);
  const suffix = globPattern.slice(wildcardIndex + 1);
  return (
    candidatePath.startsWith(prefix) &&
    candidatePath.endsWith(suffix) &&
    candidatePath.length >= prefix.length + suffix.length
  );
}

function assertRelativePathsResolveToFiles(
  relativePaths: readonly string[],
  pathSetLabel: string,
): void {
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(SDK_PACKAGE_ROOT, relativePath);
    expect(
      fs.existsSync(absolutePath),
      `Expected ${pathSetLabel} path to exist: ${relativePath}`,
    ).to.equal(true);
    expect(
      fs.statSync(absolutePath).isFile(),
      `Expected ${pathSetLabel} path to resolve to file: ${relativePath}`,
    ).to.equal(true);
  }
}

function listSquadsBarrelExportedSourcePaths(): readonly string[] {
  const squadsBarrelSource = fs.readFileSync(SQUADS_BARREL_INDEX_PATH, 'utf8');
  const exportStatements = squadsBarrelSource
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('export * from'));
  const exportedSourcePaths: string[] = [];

  for (const exportStatement of exportStatements) {
    const exportMatch = /^export \* from '\.\/(.+)\.js';$/.exec(
      exportStatement,
    );
    expect(
      exportMatch,
      `Expected squads barrel export statement to follow canonical .js re-export shape: ${exportStatement}`,
    ).to.not.equal(null);
    if (!exportMatch) {
      continue;
    }
    exportedSourcePaths.push(`src/squads/${exportMatch[1]}.ts`);
  }

  return exportedSourcePaths.sort(compareLexicographically);
}

function assertPathSnapshotIsolation(
  listPaths: () => readonly string[],
  pathSetLabel: string,
): void {
  const baselinePaths = listPaths();
  const callerMutableSnapshot = [...listPaths()];
  callerMutableSnapshot.pop();
  const subsequentPaths = listPaths();

  expect(callerMutableSnapshot).to.not.deep.equal(baselinePaths);
  expect(subsequentPaths).to.deep.equal(baselinePaths);
  expect(subsequentPaths).to.not.equal(baselinePaths);
}

describe('squads barrel exports', () => {
  it('keeps canonical sdk squads path-constant relationships', () => {
    expect(path.relative(SDK_PACKAGE_ROOT, SDK_SQUADS_SOURCE_DIR)).to.equal(
      'src/squads',
    );
    expect(path.relative(SDK_PACKAGE_ROOT, SDK_ROOT_INDEX_PATH)).to.equal(
      'src/index.ts',
    );
    expect(path.relative(SDK_PACKAGE_ROOT, SQUADS_BARREL_INDEX_PATH)).to.equal(
      'src/squads/index.ts',
    );
    expect(path.relative(SDK_PACKAGE_ROOT, SDK_PACKAGE_JSON_PATH)).to.equal(
      'package.json',
    );
  });

  it('keeps sdk squads test command constants normalized and scoped', () => {
    assertCanonicalCliCommandShape(
      SDK_SQUADS_TEST_COMMAND_PREFIX,
      'sdk squads test command prefix',
    );
    expect(
      SDK_SQUADS_TEST_COMMAND_PREFIX.startsWith('mocha --config '),
    ).to.equal(true);
    expect(SDK_SQUADS_TEST_COMMAND_PREFIX.includes('.mocharc.json')).to.equal(
      true,
    );
    expect(SDK_SQUADS_TEST_COMMAND_PREFIX.endsWith(' ')).to.equal(false);
    expect(SDK_SQUADS_TEST_COMMAND_PREFIX.includes('"')).to.equal(false);
    expect(SDK_SQUADS_TEST_COMMAND_PREFIX.includes("'")).to.equal(false);
    expect(Object.isFrozen(SDK_SQUADS_TEST_TOKEN_PATHS)).to.equal(true);
    expect(SDK_SQUADS_TEST_TOKEN_PATHS).to.deep.equal([SDK_SQUADS_TEST_GLOB]);
    assertSdkSquadsTokenPathSetNormalizedAndDeduplicated(
      SDK_SQUADS_TEST_TOKEN_PATHS,
      'sdk squads test-token constant set',
    );
    for (const tokenPath of SDK_SQUADS_TEST_TOKEN_PATHS) {
      assertSingleAsteriskGlobShape(
        tokenPath,
        'sdk squads test-token constant glob',
      );
    }
  });

  it('keeps expected canonical sdk squads test command prefix', () => {
    expect(SDK_SQUADS_TEST_COMMAND_PREFIX).to.equal(
      'mocha --config .mocharc.json',
    );
  });

  it('keeps expected canonical sdk squads test glob', () => {
    expect(SDK_SQUADS_TEST_GLOB).to.equal('src/squads/*.test.ts');
  });

  it('keeps expected canonical sdk squads test command', () => {
    expect(EXPECTED_SDK_SQUADS_TEST_SCRIPT).to.equal(
      "mocha --config .mocharc.json 'src/squads/*.test.ts'",
    );
  });

  it('re-exports squads config/constants', () => {
    expect(squadsConfigs).to.equal(directSquadsConfigs);
    expect(getSquadsChains).to.equal(directGetSquadsChains);
    expect(getSquadsKeysForResolvedChain).to.equal(
      directGetSquadsKeysForResolvedChain,
    );
    expect(resolveSquadsChainName).to.equal(directResolveSquadsChainName);
  });

  it('re-exports squads transaction reader', () => {
    expect(SquadsTransactionReader).to.equal(DirectSquadsTransactionReader);
  });

  it('re-exports squads error format helpers', () => {
    expect(stringifyUnknownSquadsError).to.equal(
      directStringifyUnknownSquadsError,
    );
    expect(normalizeStringifiedSquadsError).to.equal(
      directNormalizeStringifiedSquadsError,
    );
    expect(BUILTIN_SQUADS_ERROR_LABELS).to.equal(
      directBuiltinSquadsErrorLabels,
    );
    expect(DEFAULT_SQUADS_ERROR_PLACEHOLDER).to.equal(
      directDefaultSquadsErrorPlaceholder,
    );
  });

  it('keeps squads barrel wired through sdk root index source', () => {
    const rootIndexSource = fs.readFileSync(SDK_ROOT_INDEX_PATH, 'utf8');
    const squadsExportStatement = "export * from './squads/index.js';";
    expect(rootIndexSource).to.include(squadsExportStatement);
    expect(countOccurrences(rootIndexSource, squadsExportStatement)).to.equal(
      1,
    );
  });

  it('keeps sdk root index squads exports routed only through squads barrel', () => {
    const rootIndexSource = fs.readFileSync(SDK_ROOT_INDEX_PATH, 'utf8');
    const directSquadsSubmoduleStatements = [
      "export * from './squads/config.js';",
      "export * from './squads/utils.js';",
      "export * from './squads/transaction-reader.js';",
      "export * from './squads/error-format.js';",
    ] as const;

    for (const statement of directSquadsSubmoduleStatements) {
      expect(rootIndexSource.includes(statement)).to.equal(false);
    }
  });

  it('keeps sdk root index with a single squads export statement', () => {
    const rootIndexSource = fs.readFileSync(SDK_ROOT_INDEX_PATH, 'utf8');
    const squadsExportStatements = rootIndexSource
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) => line.startsWith('export') && line.includes("from './squads/"),
      );

    expect(squadsExportStatements).to.deep.equal([
      "export * from './squads/index.js';",
    ]);
  });

  it('keeps sdk root index free of non-export squads references', () => {
    const rootIndexSource = fs.readFileSync(SDK_ROOT_INDEX_PATH, 'utf8');
    const squadsReferenceLines = rootIndexSource
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes("from './squads/"));

    expect(squadsReferenceLines).to.deep.equal([
      "export * from './squads/index.js';",
    ]);
    expect(countOccurrences(rootIndexSource, './squads/')).to.equal(1);
  });

  it('keeps expected squads submodule exports in squads barrel source', () => {
    const squadsBarrelSource = fs.readFileSync(
      SQUADS_BARREL_INDEX_PATH,
      'utf8',
    );
    for (const statement of EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS) {
      expect(squadsBarrelSource).to.include(statement);
      expect(countOccurrences(squadsBarrelSource, statement)).to.equal(1);
    }
  });

  it('keeps squads barrel export statement set exact and ordered', () => {
    const squadsBarrelSource = fs.readFileSync(
      SQUADS_BARREL_INDEX_PATH,
      'utf8',
    );
    const exportStatements = squadsBarrelSource
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('export * from'));

    expect(exportStatements).to.deep.equal([
      ...EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS,
    ]);
  });

  it('keeps squads barrel free of non-export local references', () => {
    const squadsBarrelSource = fs.readFileSync(
      SQUADS_BARREL_INDEX_PATH,
      'utf8',
    );
    const localReferenceLines = squadsBarrelSource
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes("from './"));

    expect(localReferenceLines).to.deep.equal([
      ...EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS,
    ]);
    expect(countOccurrences(squadsBarrelSource, "from './")).to.equal(4);
  });

  it('keeps sdk package explicitly depending on @sqds/multisig', () => {
    const sdkPackageJson = JSON.parse(
      fs.readFileSync(SDK_PACKAGE_JSON_PATH, 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      exports?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(sdkPackageJson.dependencies?.['@sqds/multisig']).to.not.equal(
      undefined,
    );
    expect(sdkPackageJson.dependencies?.['@sqds/multisig']).to.equal(
      'catalog:',
    );
    expect(sdkPackageJson.devDependencies?.['@sqds/multisig']).to.equal(
      undefined,
    );
    expect(sdkPackageJson.scripts?.['test:squads']).to.equal(
      EXPECTED_SDK_SQUADS_TEST_SCRIPT,
    );
    assertCanonicalCliCommandShape(
      EXPECTED_SDK_SQUADS_TEST_SCRIPT,
      'expected sdk squads test command',
    );
    expect(
      EXPECTED_SDK_SQUADS_TEST_SCRIPT.startsWith(
        `${SDK_SQUADS_TEST_COMMAND_PREFIX} `,
      ),
    ).to.equal(true);
    expect(EXPECTED_SDK_SQUADS_TEST_SCRIPT.includes('"')).to.equal(false);
    expect(countOccurrences(EXPECTED_SDK_SQUADS_TEST_SCRIPT, "'")).to.equal(
      SDK_SQUADS_TEST_TOKEN_PATHS.length * 2,
    );
    expect(
      countOccurrences(
        EXPECTED_SDK_SQUADS_TEST_SCRIPT,
        SDK_SQUADS_TEST_COMMAND_PREFIX,
      ),
    ).to.equal(1);
    expect(
      EXPECTED_SDK_SQUADS_TEST_SCRIPT.includes('typescript/infra'),
    ).to.equal(false);
    const quotedTestTokens = getQuotedSdkSquadsTestTokens();
    assertSdkQuotedCommandTokenSet(
      quotedTestTokens,
      'quoted sdk squads test command',
    );
    expect(sdkPackageJson.exports?.['.']).to.equal('./dist/index.js');
    expect(sdkPackageJson.exports?.['./squads']).to.equal(undefined);
    expect(sdkPackageJson.exports?.['./squads/*']).to.equal(undefined);
    const sdkExportKeys = Object.keys(sdkPackageJson.exports ?? {});
    expect(sdkExportKeys).to.deep.equal(['.']);
    expect(
      sdkExportKeys.some((exportKey) => exportKey.startsWith('./squads')),
    ).to.equal(false);
  });

  it('keeps quoted sdk squads command tokens isolated from caller mutation', () => {
    const baselineQuotedTokens = getQuotedSdkSquadsTestTokens();
    assertSdkQuotedCommandTokenSet(
      baselineQuotedTokens,
      'baseline quoted sdk squads command',
    );
    const callerMutatedQuotedTokens = [...getQuotedSdkSquadsTestTokens()];
    callerMutatedQuotedTokens.pop();

    const subsequentQuotedTokens = getQuotedSdkSquadsTestTokens();
    expect(callerMutatedQuotedTokens).to.not.deep.equal(baselineQuotedTokens);
    assertSdkQuotedCommandTokenSet(
      subsequentQuotedTokens,
      'subsequent quoted sdk squads command',
    );
    expect(subsequentQuotedTokens).to.deep.equal(baselineQuotedTokens);
    expect(subsequentQuotedTokens).to.not.equal(baselineQuotedTokens);
  });

  it('keeps sdk squads command token order canonical', () => {
    const quotedTestTokens = getQuotedSdkSquadsTestTokens();
    expect(quotedTestTokens).to.deep.equal([...SDK_SQUADS_TEST_TOKEN_PATHS]);
  });

  it('keeps sdk squads token-path constants isolated from caller mutation', () => {
    const baselineTokenPaths = [...SDK_SQUADS_TEST_TOKEN_PATHS];
    assertSdkSquadsTokenPathSetNormalizedAndDeduplicated(
      baselineTokenPaths,
      'baseline sdk squads token-path constants',
    );
    const callerMutatedTokenPaths = [...SDK_SQUADS_TEST_TOKEN_PATHS];
    callerMutatedTokenPaths.pop();

    const subsequentTokenPaths = [...SDK_SQUADS_TEST_TOKEN_PATHS];
    assertSdkSquadsTokenPathSetNormalizedAndDeduplicated(
      subsequentTokenPaths,
      'subsequent sdk squads token-path constants',
    );
    expect(callerMutatedTokenPaths).to.not.deep.equal(baselineTokenPaths);
    expect(subsequentTokenPaths).to.deep.equal(baselineTokenPaths);
  });

  it('keeps sdk squads test globs aligned with discovered squads test files', () => {
    const discoveredSquadsTestPaths = listSdkSquadsTestFilePaths();
    expect(
      discoveredSquadsTestPaths.length,
      'Expected at least one discovered sdk squads test file',
    ).to.be.greaterThan(0);

    for (const discoveredPath of discoveredSquadsTestPaths) {
      assertSdkSquadsTestTokenShape(
        discoveredPath,
        'discovered sdk squads test file path',
      );
      expect(
        SDK_SQUADS_TEST_TOKEN_PATHS.some((globPattern) =>
          matchesSingleAsteriskGlob(discoveredPath, globPattern),
        ),
        `Expected discovered sdk squads test file to be covered by command glob: ${discoveredPath}`,
      ).to.equal(true);
    }

    for (const globPattern of SDK_SQUADS_TEST_TOKEN_PATHS) {
      const matchingDiscoveredPaths = discoveredSquadsTestPaths.filter(
        (pathValue) => matchesSingleAsteriskGlob(pathValue, globPattern),
      );
      expect(
        matchingDiscoveredPaths.length,
        `Expected sdk squads test glob to match at least one discovered squads test file: ${globPattern}`,
      ).to.be.greaterThan(0);
    }
  });

  it('keeps expected canonical sdk squads test file paths', () => {
    expect(EXPECTED_SDK_SQUADS_TEST_FILE_PATHS).to.deep.equal([
      'src/squads/config.test.ts',
      'src/squads/error-format.test.ts',
      'src/squads/index.test.ts',
      'src/squads/inspection.test.ts',
      'src/squads/provider.test.ts',
      'src/squads/transaction-reader.test.ts',
      'src/squads/utils.test.ts',
    ]);
  });

  it('keeps expected canonical sdk squads Reflect.apply mutation-test file paths', () => {
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS,
    ).to.deep.equal([
      'src/squads/config.test.ts',
      'src/squads/error-format.test.ts',
      'src/squads/inspection.test.ts',
      'src/squads/provider.test.ts',
      'src/squads/transaction-reader.test.ts',
      'src/squads/utils.test.ts',
    ]);
  });

  it('keeps expected canonical sdk squads Reflect.apply mutation-test counts', () => {
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS,
    ).to.deep.equal([
      {
        testPath: 'src/squads/config.test.ts',
        expectedMutationTestCount: 1,
      },
      {
        testPath: 'src/squads/error-format.test.ts',
        expectedMutationTestCount: 2,
      },
      {
        testPath: 'src/squads/inspection.test.ts',
        expectedMutationTestCount: 1,
      },
      {
        testPath: 'src/squads/provider.test.ts',
        expectedMutationTestCount: 1,
      },
      {
        testPath: 'src/squads/transaction-reader.test.ts',
        expectedMutationTestCount: 2,
      },
      {
        testPath: 'src/squads/utils.test.ts',
        expectedMutationTestCount: 2,
      },
    ]);
  });

  it('keeps expected canonical sdk squads total Reflect.apply mutation-test count', () => {
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNT,
    ).to.equal(9);
  });

  it('keeps expected canonical sdk squads Reflect.apply-captured runtime source paths', () => {
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
    ).to.deep.equal([
      'src/squads/config.ts',
      'src/squads/error-format.ts',
      'src/squads/transaction-reader.ts',
      'src/squads/utils.ts',
      'src/squads/validation.ts',
    ]);
  });

  it('keeps expected canonical sdk squads Reflect.apply non-captured runtime source paths', () => {
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
    ).to.deep.equal(['src/squads/inspection.ts', 'src/squads/provider.ts']);
  });

  it('keeps expected canonical sdk squads Reflect.apply runtime identifier-reference counts', () => {
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS,
    ).to.deep.equal([
      {
        runtimeSourcePath: 'src/squads/config.ts',
        expectedReflectApplyIdentifierReferenceCount: 1,
      },
      {
        runtimeSourcePath: 'src/squads/error-format.ts',
        expectedReflectApplyIdentifierReferenceCount: 1,
      },
      {
        runtimeSourcePath: 'src/squads/inspection.ts',
        expectedReflectApplyIdentifierReferenceCount: 0,
      },
      {
        runtimeSourcePath: 'src/squads/provider.ts',
        expectedReflectApplyIdentifierReferenceCount: 0,
      },
      {
        runtimeSourcePath: 'src/squads/transaction-reader.ts',
        expectedReflectApplyIdentifierReferenceCount: 1,
      },
      {
        runtimeSourcePath: 'src/squads/utils.ts',
        expectedReflectApplyIdentifierReferenceCount: 1,
      },
      {
        runtimeSourcePath: 'src/squads/validation.ts',
        expectedReflectApplyIdentifierReferenceCount: 1,
      },
    ]);
  });

  it('keeps expected canonical sdk squads REFLECT_APPLY invocation counts', () => {
    expect(EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS).to.deep.equal([
      {
        runtimeSourcePath: 'src/squads/config.ts',
        expectedReflectApplyInvocationCount: 7,
      },
      {
        runtimeSourcePath: 'src/squads/error-format.ts',
        expectedReflectApplyInvocationCount: 7,
      },
      {
        runtimeSourcePath: 'src/squads/inspection.ts',
        expectedReflectApplyInvocationCount: 0,
      },
      {
        runtimeSourcePath: 'src/squads/provider.ts',
        expectedReflectApplyInvocationCount: 0,
      },
      {
        runtimeSourcePath: 'src/squads/transaction-reader.ts',
        expectedReflectApplyInvocationCount: 1,
      },
      {
        runtimeSourcePath: 'src/squads/utils.ts',
        expectedReflectApplyInvocationCount: 1,
      },
      {
        runtimeSourcePath: 'src/squads/validation.ts',
        expectedReflectApplyInvocationCount: 1,
      },
    ]);
  });

  it('keeps expected canonical sdk squads REFLECT_APPLY capture declaration counts', () => {
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS,
    ).to.deep.equal([
      {
        runtimeSourcePath: 'src/squads/config.ts',
        expectedReflectApplyCaptureDeclarationCount: 1,
      },
      {
        runtimeSourcePath: 'src/squads/error-format.ts',
        expectedReflectApplyCaptureDeclarationCount: 1,
      },
      {
        runtimeSourcePath: 'src/squads/inspection.ts',
        expectedReflectApplyCaptureDeclarationCount: 0,
      },
      {
        runtimeSourcePath: 'src/squads/provider.ts',
        expectedReflectApplyCaptureDeclarationCount: 0,
      },
      {
        runtimeSourcePath: 'src/squads/transaction-reader.ts',
        expectedReflectApplyCaptureDeclarationCount: 1,
      },
      {
        runtimeSourcePath: 'src/squads/utils.ts',
        expectedReflectApplyCaptureDeclarationCount: 1,
      },
      {
        runtimeSourcePath: 'src/squads/validation.ts',
        expectedReflectApplyCaptureDeclarationCount: 1,
      },
    ]);
  });

  it('keeps expected canonical sdk squads total Reflect.apply identifier-reference count', () => {
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNT,
    ).to.equal(5);
  });

  it('keeps expected canonical sdk squads total REFLECT_APPLY invocation count', () => {
    expect(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNT).to.equal(
      17,
    );
  });

  it('keeps expected canonical sdk squads total REFLECT_APPLY capture declaration count', () => {
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNT,
    ).to.equal(5);
  });

  it('keeps expected canonical sdk squads total REFLECT_APPLY captured runtime source count', () => {
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    ).to.equal(5);
  });

  it('keeps expected canonical sdk squads total REFLECT_APPLY non-captured runtime source count', () => {
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_COUNT,
    ).to.equal(2);
  });

  it('keeps expected canonical sdk squads total REFLECT_APPLY runtime source count', () => {
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT,
    ).to.equal(7);
  });

  it('keeps expected canonical sdk squads total Reflect.apply zero identifier-reference count', () => {
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_IDENTIFIER_REFERENCE_COUNT,
    ).to.equal(2);
  });

  it('keeps expected canonical sdk squads total REFLECT_APPLY zero invocation count', () => {
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_INVOCATION_COUNT,
    ).to.equal(2);
  });

  it('keeps expected canonical sdk squads total REFLECT_APPLY zero capture declaration count', () => {
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_CAPTURE_DECLARATION_COUNT,
    ).to.equal(2);
  });

  it('keeps expected canonical sdk squads Reflect.apply total constants arithmetically aligned', () => {
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT +
        EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_COUNT,
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT);
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_IDENTIFIER_REFERENCE_COUNT +
        EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT);
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_INVOCATION_COUNT +
        EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT);
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_CAPTURE_DECLARATION_COUNT +
        EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT);
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNT,
    ).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNT,
    );
  });

  it('keeps expected canonical sdk squads Reflect.apply mutation runtime coverage map', () => {
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE,
    ).to.deep.equal([
      {
        runtimeSourcePath: 'src/squads/config.ts',
        coveringTestPaths: ['src/squads/config.test.ts'],
      },
      {
        runtimeSourcePath: 'src/squads/error-format.ts',
        coveringTestPaths: ['src/squads/error-format.test.ts'],
      },
      {
        runtimeSourcePath: 'src/squads/inspection.ts',
        coveringTestPaths: ['src/squads/inspection.test.ts'],
      },
      {
        runtimeSourcePath: 'src/squads/provider.ts',
        coveringTestPaths: ['src/squads/provider.test.ts'],
      },
      {
        runtimeSourcePath: 'src/squads/transaction-reader.ts',
        coveringTestPaths: ['src/squads/transaction-reader.test.ts'],
      },
      {
        runtimeSourcePath: 'src/squads/utils.ts',
        coveringTestPaths: ['src/squads/utils.test.ts'],
      },
      {
        runtimeSourcePath: 'src/squads/validation.ts',
        coveringTestPaths: ['src/squads/utils.test.ts'],
      },
    ]);
  });

  it('keeps sdk squads test-file path constants normalized and immutable', () => {
    expect(Object.isFrozen(EXPECTED_SDK_SQUADS_TEST_FILE_PATHS)).to.equal(true);
    expect(new Set(EXPECTED_SDK_SQUADS_TEST_FILE_PATHS).size).to.equal(
      EXPECTED_SDK_SQUADS_TEST_FILE_PATHS.length,
    );
    expect(
      [...EXPECTED_SDK_SQUADS_TEST_FILE_PATHS].sort(compareLexicographically),
    ).to.deep.equal([...EXPECTED_SDK_SQUADS_TEST_FILE_PATHS]);
    for (const testPath of EXPECTED_SDK_SQUADS_TEST_FILE_PATHS) {
      assertSdkSquadsTestTokenShape(testPath, 'expected sdk squads test path');
    }
    assertRelativePathsResolveToFiles(
      EXPECTED_SDK_SQUADS_TEST_FILE_PATHS,
      'expected sdk squads test path constant',
    );
  });

  it('keeps sdk squads Reflect.apply mutation-test path constants normalized and immutable', () => {
    expect(
      Object.isFrozen(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS,
      ),
    ).to.equal(true);
    expect(
      new Set(EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS).size,
    ).to.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS.length,
    );
    expect(
      [...EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS].sort(
        compareLexicographically,
      ),
    ).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS,
    ]);
    for (const testPath of EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS) {
      assertSdkSquadsTestTokenShape(
        testPath,
        'expected sdk squads Reflect.apply mutation test path',
      );
    }
    assertRelativePathsResolveToFiles(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS,
      'expected sdk squads Reflect.apply mutation test path constant',
    );
  });

  it('keeps sdk squads Reflect.apply-captured runtime source-path constants normalized and immutable', () => {
    expect(
      Object.isFrozen(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
      ),
    ).to.equal(true);
    expect(
      new Set(EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS)
        .size,
    ).to.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS.length,
    );
    expect(
      [...EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS].sort(
        compareLexicographically,
      ),
    ).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
    ]);
    for (const sourcePath of EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS) {
      assertSdkSquadsNonTestSourcePathShape(
        sourcePath,
        'expected sdk squads Reflect.apply-captured runtime source path',
      );
    }
    assertRelativePathsResolveToFiles(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
      'expected sdk squads Reflect.apply-captured runtime source path constant',
    );
  });

  it('keeps sdk squads Reflect.apply non-captured runtime source-path constants normalized and immutable', () => {
    expect(
      Object.isFrozen(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
      ),
    ).to.equal(true);
    expect(
      new Set(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
      ).size,
    ).to.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS.length,
    );
    expect(
      [
        ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
      ].sort(compareLexicographically),
    ).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
    ]);
    for (const sourcePath of EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS) {
      assertSdkSquadsNonTestSourcePathShape(
        sourcePath,
        'expected sdk squads Reflect.apply non-captured runtime source path',
      );
    }
    assertRelativePathsResolveToFiles(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
      'expected sdk squads Reflect.apply non-captured runtime source path constant',
    );
  });

  it('keeps sdk squads Reflect.apply runtime identifier-reference count constants normalized and immutable', () => {
    expect(
      Object.isFrozen(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS,
      ),
    ).to.equal(true);
    expect(
      new Set(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.map(
          ({ runtimeSourcePath }) => runtimeSourcePath,
        ),
      ).size,
    ).to.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.length,
    );
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ),
    ).to.deep.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ).toSorted(compareLexicographically),
    );
    for (const referenceCountEntry of EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS) {
      expect(Object.isFrozen(referenceCountEntry)).to.equal(true);
      expect(
        referenceCountEntry.expectedReflectApplyIdentifierReferenceCount,
      ).to.be.greaterThanOrEqual(0);
    }
  });

  it('keeps sdk squads REFLECT_APPLY invocation count constants normalized and immutable', () => {
    expect(
      Object.isFrozen(EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS),
    ).to.equal(true);
    expect(
      Object.isFrozen(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS,
      ),
    ).to.equal(true);
    expect(
      new Set(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.map(
          ({ runtimeSourcePath }) => runtimeSourcePath,
        ),
      ).size,
    ).to.equal(EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.length);
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ),
    ).to.deep.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ).toSorted(compareLexicographically),
    );
    for (const invocationCountEntry of EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS) {
      expect(Object.isFrozen(invocationCountEntry)).to.equal(true);
      expect(
        invocationCountEntry.expectedReflectApplyInvocationCount,
      ).to.be.greaterThanOrEqual(0);
    }
  });

  it('keeps sdk squads REFLECT_APPLY capture declaration count constants normalized and immutable', () => {
    expect(
      Object.isFrozen(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS,
      ),
    ).to.equal(true);
    expect(
      new Set(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.map(
          ({ runtimeSourcePath }) => runtimeSourcePath,
        ),
      ).size,
    ).to.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.length,
    );
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ),
    ).to.deep.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ).toSorted(compareLexicographically),
    );
    for (const captureDeclarationCountEntry of EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS) {
      expect(Object.isFrozen(captureDeclarationCountEntry)).to.equal(true);
      expect(
        captureDeclarationCountEntry.expectedReflectApplyCaptureDeclarationCount,
      ).to.be.greaterThanOrEqual(0);
    }
  });

  it('keeps sdk Reflect.apply mutation tests aligned with expected test-file paths', () => {
    const discoveredReflectApplyMutationTestPaths =
      listSdkSquadsTestFilePathsContainingPattern(
        REFLECT_APPLY_MUTATION_TEST_TITLE_PATTERN,
      );
    expect(discoveredReflectApplyMutationTestPaths).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS,
    ]);
  });

  it('keeps sdk squads pattern-path discovery stable for global regex inputs', () => {
    const nonGlobalMutationPathPattern = /Reflect\.apply is mutated/;
    const globalMutationPathPattern = /Reflect\.apply is mutated/g;
    const nonGlobalCapturePattern = /const REFLECT_APPLY = Reflect\.apply/;
    const globalCapturePattern = /const REFLECT_APPLY = Reflect\.apply/g;

    expect(
      listSdkSquadsTestFilePathsContainingPattern(globalMutationPathPattern),
    ).to.deep.equal(
      listSdkSquadsTestFilePathsContainingPattern(nonGlobalMutationPathPattern),
    );
    expect(
      listSdkSquadsNonTestSourceFilePathsContainingPattern(
        globalCapturePattern,
      ),
    ).to.deep.equal(
      listSdkSquadsNonTestSourceFilePathsContainingPattern(
        nonGlobalCapturePattern,
      ),
    );
  });

  it('keeps sdk squads pattern-path discovery stable across repeated global regex reuse', () => {
    const reusableGlobalMutationPattern = /Reflect\.apply is mutated/g;
    const reusableGlobalCapturePattern =
      /const REFLECT_APPLY = Reflect\.apply/g;

    const firstMutationDiscovery = listSdkSquadsTestFilePathsContainingPattern(
      reusableGlobalMutationPattern,
    );
    const secondMutationDiscovery = listSdkSquadsTestFilePathsContainingPattern(
      reusableGlobalMutationPattern,
    );
    expect(secondMutationDiscovery).to.deep.equal(firstMutationDiscovery);

    const firstCaptureDiscovery =
      listSdkSquadsNonTestSourceFilePathsContainingPattern(
        reusableGlobalCapturePattern,
      );
    const secondCaptureDiscovery =
      listSdkSquadsNonTestSourceFilePathsContainingPattern(
        reusableGlobalCapturePattern,
      );
    expect(secondCaptureDiscovery).to.deep.equal(firstCaptureDiscovery);
  });

  it('keeps sdk Reflect.apply mutation tests using explicit Reflect.apply monkey-patch setup', () => {
    for (const relativeTestPath of EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS) {
      const absoluteTestPath = path.join(SDK_PACKAGE_ROOT, relativeTestPath);
      const source = fs.readFileSync(absoluteTestPath, 'utf8');
      expect(
        REFLECT_APPLY_MONKEY_PATCH_PATTERN.test(source),
        `Expected Reflect.apply mutation test file to monkey-patch Reflect.apply: ${relativeTestPath}`,
      ).to.equal(true);
    }
  });

  it('keeps sdk Reflect.apply mutation tests capturing and restoring original apply counts', () => {
    expect(
      Object.isFrozen(EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS),
    ).to.equal(true);
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS.length,
    ).to.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS.length,
    );
    expect(
      new Set(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS.map(
          ({ testPath }) => testPath,
        ),
      ).size,
    ).to.equal(EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS.length);
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS.reduce(
        (sum, { expectedMutationTestCount }) => sum + expectedMutationTestCount,
        0,
      ),
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNT);

    for (const {
      testPath,
      expectedMutationTestCount,
    } of EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS) {
      const absoluteTestPath = path.join(SDK_PACKAGE_ROOT, testPath);
      const source = fs.readFileSync(absoluteTestPath, 'utf8');
      expect(expectedMutationTestCount).to.be.greaterThan(0);
      expect(
        countOccurrences(source, 'Reflect.apply is mutated'),
        `Expected Reflect.apply mutation-test title count for ${testPath}`,
      ).to.equal(expectedMutationTestCount);
      expect(
        countOccurrences(source, REFLECT_APPLY_MUTATION_THROW_STATEMENT),
        `Expected Reflect.apply mutation throw statement count for ${testPath}`,
      ).to.equal(expectedMutationTestCount);
      expect(
        countOccurrences(source, REFLECT_APPLY_CAPTURE_STATEMENT),
        `Expected Reflect.apply capture statement count for ${testPath}`,
      ).to.equal(expectedMutationTestCount);
      expect(
        countOccurrences(source, REFLECT_APPLY_MONKEY_PATCH_STATEMENT),
        `Expected Reflect.apply monkey-patch defineProperty count for ${testPath}`,
      ).to.equal(expectedMutationTestCount * 2);
      expect(
        countOccurrences(source, REFLECT_APPLY_RESTORE_STATEMENT),
        `Expected Reflect.apply restore statement count for ${testPath}`,
      ).to.equal(expectedMutationTestCount);
    }
  });

  it('keeps sdk Reflect.apply mutation test-title counts aligned with expected total', () => {
    const discoveredReflectApplyMutationTestPaths =
      listSdkSquadsTestFilePathsContainingPattern(
        REFLECT_APPLY_MUTATION_TEST_TITLE_PATTERN,
      );
    let discoveredMutationTitleCount = 0;
    for (const relativeTestPath of discoveredReflectApplyMutationTestPaths) {
      const absoluteTestPath = path.join(SDK_PACKAGE_ROOT, relativeTestPath);
      const source = fs.readFileSync(absoluteTestPath, 'utf8');
      discoveredMutationTitleCount += countOccurrences(
        source,
        'Reflect.apply is mutated',
      );
    }

    expect(discoveredMutationTitleCount).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNT,
    );
  });

  it('keeps sdk Reflect.apply mutation tests covering expected runtime source modules', () => {
    expect(
      Object.isFrozen(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE,
      ),
    ).to.equal(true);
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE.length,
    ).to.be.greaterThan(0);
    expect(
      new Set(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE.map(
          ({ runtimeSourcePath }) => runtimeSourcePath,
        ),
      ).size,
    ).to.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE.length,
    );

    const nonTestRuntimeSourcePathSet = new Set(
      listSdkSquadsNonTestSourceFilePaths(),
    );
    const discoveredReflectApplyMutationTestPathSet = new Set(
      listSdkSquadsTestFilePathsContainingPattern(
        REFLECT_APPLY_MUTATION_TEST_TITLE_PATTERN,
      ),
    );

    for (const {
      runtimeSourcePath,
      coveringTestPaths,
    } of EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE) {
      expect(
        nonTestRuntimeSourcePathSet.has(runtimeSourcePath),
        `Expected runtime source to exist in sdk squads non-test source set: ${runtimeSourcePath}`,
      ).to.equal(true);
      expect(Object.isFrozen(coveringTestPaths)).to.equal(true);
      expect(coveringTestPaths.length).to.be.greaterThan(0);
      expect(new Set(coveringTestPaths).size).to.equal(
        coveringTestPaths.length,
      );
      expect(
        [...coveringTestPaths].sort(compareLexicographically),
      ).to.deep.equal([...coveringTestPaths]);

      for (const coveringTestPath of coveringTestPaths) {
        expect(
          discoveredReflectApplyMutationTestPathSet.has(coveringTestPath),
          `Expected runtime source to be covered by Reflect.apply mutation test file: ${runtimeSourcePath} -> ${coveringTestPath}`,
        ).to.equal(true);
      }
    }
  });

  it('keeps sdk runtime Reflect.apply capture inventory aligned with canonical source table', () => {
    const discoveredReflectApplyCaptureSourcePaths =
      listSdkSquadsNonTestSourceFilePathsContainingPattern(
        REFLECT_APPLY_CAPTURE_DECLARATION_PATTERN,
      );
    expect(discoveredReflectApplyCaptureSourcePaths).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
    ]);
  });

  it('keeps sdk Reflect.apply capture inventory represented in runtime coverage map', () => {
    const coverageRuntimeSourcePathSet = new Set<string>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ),
    );

    for (const captureSourcePath of EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS) {
      expect(
        coverageRuntimeSourcePathSet.has(captureSourcePath),
        `Expected Reflect.apply-captured runtime source to have runtime coverage mapping: ${captureSourcePath}`,
      ).to.equal(true);
    }
  });

  it('keeps sdk Reflect.apply runtime source partitioning aligned with coverage-map sources', () => {
    const capturedRuntimeSourcePathSet = new Set(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
    );
    const nonCapturedRuntimeSourcePathSet = new Set(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
    );
    const coverageRuntimeSourcePaths =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      );

    for (const capturedSourcePath of capturedRuntimeSourcePathSet) {
      expect(nonCapturedRuntimeSourcePathSet.has(capturedSourcePath)).to.equal(
        false,
      );
    }

    const expectedPartitionedRuntimeSourcePaths = [
      ...capturedRuntimeSourcePathSet,
      ...nonCapturedRuntimeSourcePathSet,
    ].sort(compareLexicographically);
    expect(coverageRuntimeSourcePaths).to.deep.equal(
      expectedPartitionedRuntimeSourcePaths,
    );
  });

  it('keeps sdk Reflect.apply runtime source partition totals aligned with discovered runtime inventory', () => {
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS.length,
    ).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS.length,
    ).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT +
        EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_COUNT,
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT);
    expect(
      listSdkSquadsNonTestSourceFilePaths().filter(
        (sourcePath) => sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH,
      ).length,
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT);
    expect(
      listSdkSquadsNonTestSourceFilePaths().filter(
        (sourcePath) => sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH,
      ).length,
    ).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT +
        EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
  });

  it('keeps sdk Reflect.apply non-capture runtime inventory aligned across discovery and coverage', () => {
    const discoveredCapturedRuntimeSourcePathSet = new Set(
      listSdkSquadsNonTestSourceFilePathsContainingPattern(
        REFLECT_APPLY_CAPTURE_DECLARATION_PATTERN,
      ),
    );
    const expectedNonCapturedRuntimeSourcePaths = [
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
    ];
    const discoveredNonCapturedRuntimeSourcePaths =
      listSdkSquadsNonTestSourceFilePaths()
        .filter((sourcePath) => sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH)
        .filter(
          (sourcePath) =>
            !discoveredCapturedRuntimeSourcePathSet.has(sourcePath),
        )
        .sort(compareLexicographically);
    expect(discoveredNonCapturedRuntimeSourcePaths).to.deep.equal(
      expectedNonCapturedRuntimeSourcePaths,
    );

    const capturedRuntimeSourcePathSet = new Set(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
    );
    const coverageNonCapturedRuntimeSourcePaths =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      )
        .filter(
          (runtimeSourcePath) =>
            !capturedRuntimeSourcePathSet.has(runtimeSourcePath),
        )
        .sort(compareLexicographically);
    expect(coverageNonCapturedRuntimeSourcePaths).to.deep.equal(
      expectedNonCapturedRuntimeSourcePaths,
    );
  });

  it('keeps sdk runtime Reflect.apply identifier references aligned with capture partition tables', () => {
    const discoveredRuntimeSourcePaths = listSdkSquadsNonTestSourceFilePaths()
      .filter((sourcePath) => sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH)
      .sort(compareLexicographically);
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ),
    ).to.deep.equal(discoveredRuntimeSourcePaths);

    const capturedRuntimeSourcePathSet = new Set(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
    );
    const nonCapturedRuntimeSourcePathSet = new Set(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
    );

    for (const {
      runtimeSourcePath,
      expectedReflectApplyIdentifierReferenceCount,
    } of EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS) {
      const absoluteSourcePath = path.join(SDK_PACKAGE_ROOT, runtimeSourcePath);
      const source = fs.readFileSync(absoluteSourcePath, 'utf8');
      expect(countOccurrences(source, 'Reflect.apply')).to.equal(
        expectedReflectApplyIdentifierReferenceCount,
      );
      if (expectedReflectApplyIdentifierReferenceCount > 0) {
        expect(capturedRuntimeSourcePathSet.has(runtimeSourcePath)).to.equal(
          true,
        );
        expect(nonCapturedRuntimeSourcePathSet.has(runtimeSourcePath)).to.equal(
          false,
        );
      } else {
        expect(nonCapturedRuntimeSourcePathSet.has(runtimeSourcePath)).to.equal(
          true,
        );
        expect(capturedRuntimeSourcePathSet.has(runtimeSourcePath)).to.equal(
          false,
        );
      }
    }
  });

  it('keeps sdk runtime REFLECT_APPLY invocation usage aligned with capture partition tables', () => {
    const capturedRuntimeSourcePathSet = new Set<string>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
    );
    const nonCapturedRuntimeSourcePathSet = new Set<string>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
    );
    const expectedInvocationCountByRuntimeSourcePath = new Map<string, number>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.map(
        ({ runtimeSourcePath, expectedReflectApplyInvocationCount }) => [
          runtimeSourcePath,
          expectedReflectApplyInvocationCount,
        ],
      ),
    );

    for (const runtimeSourcePath of listSdkSquadsNonTestSourceFilePaths()
      .filter((sourcePath) => sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH)
      .sort(compareLexicographically)) {
      const absoluteSourcePath = path.join(SDK_PACKAGE_ROOT, runtimeSourcePath);
      const source = fs.readFileSync(absoluteSourcePath, 'utf8');
      const reflectApplyInvocationCount = countOccurrences(
        source,
        'REFLECT_APPLY(',
      );
      const expectedReflectApplyInvocationCount =
        expectedInvocationCountByRuntimeSourcePath.get(runtimeSourcePath);
      expect(
        expectedReflectApplyInvocationCount,
        `Expected canonical REFLECT_APPLY invocation count entry for runtime source: ${runtimeSourcePath}`,
      ).to.not.equal(undefined);
      expect(reflectApplyInvocationCount).to.equal(
        expectedReflectApplyInvocationCount,
      );

      if (capturedRuntimeSourcePathSet.has(runtimeSourcePath)) {
        expect(reflectApplyInvocationCount).to.be.greaterThan(0);
        expect(nonCapturedRuntimeSourcePathSet.has(runtimeSourcePath)).to.equal(
          false,
        );
        continue;
      }

      expect(nonCapturedRuntimeSourcePathSet.has(runtimeSourcePath)).to.equal(
        true,
      );
      expect(reflectApplyInvocationCount).to.equal(0);
    }

    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ),
    ).to.deep.equal(
      listSdkSquadsNonTestSourceFilePaths()
        .filter((sourcePath) => sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH)
        .sort(compareLexicographically),
    );
  });

  it('keeps sdk Reflect.apply identifier and REFLECT_APPLY invocation tables mutually aligned', () => {
    const identifierCountByRuntimeSourcePath = new Map<string, number>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.map(
        ({
          runtimeSourcePath,
          expectedReflectApplyIdentifierReferenceCount,
        }) => [runtimeSourcePath, expectedReflectApplyIdentifierReferenceCount],
      ),
    );

    for (const {
      runtimeSourcePath,
      expectedReflectApplyInvocationCount,
    } of EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS) {
      const expectedIdentifierReferenceCount =
        identifierCountByRuntimeSourcePath.get(runtimeSourcePath);
      expect(
        expectedIdentifierReferenceCount,
        `Expected Reflect.apply identifier-count entry for runtime source: ${runtimeSourcePath}`,
      ).to.not.equal(undefined);
      expect(expectedReflectApplyInvocationCount).to.be.greaterThanOrEqual(0);

      if (expectedReflectApplyInvocationCount > 0) {
        expect(expectedIdentifierReferenceCount).to.equal(1);
      } else {
        expect(expectedIdentifierReferenceCount).to.equal(0);
      }
    }

    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ),
    ).to.deep.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ),
    );
  });

  it('keeps sdk REFLECT_APPLY capture-declaration table aligned with capture partition and identifier tables', () => {
    const captureDeclarationCountByRuntimeSourcePath = new Map<string, number>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.map(
        ({
          runtimeSourcePath,
          expectedReflectApplyCaptureDeclarationCount,
        }) => [runtimeSourcePath, expectedReflectApplyCaptureDeclarationCount],
      ),
    );
    const capturedRuntimeSourcePathSet = new Set<string>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
    );
    const nonCapturedRuntimeSourcePathSet = new Set<string>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
    );
    const identifierCountByRuntimeSourcePath = new Map<string, number>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.map(
        ({
          runtimeSourcePath,
          expectedReflectApplyIdentifierReferenceCount,
        }) => [runtimeSourcePath, expectedReflectApplyIdentifierReferenceCount],
      ),
    );

    for (const runtimeSourcePath of listSdkSquadsNonTestSourceFilePaths()
      .filter((sourcePath) => sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH)
      .sort(compareLexicographically)) {
      const absoluteSourcePath = path.join(SDK_PACKAGE_ROOT, runtimeSourcePath);
      const source = fs.readFileSync(absoluteSourcePath, 'utf8');
      const discoveredCaptureDeclarationCount = countOccurrences(
        source,
        'const REFLECT_APPLY = Reflect.apply as <',
      );
      const expectedCaptureDeclarationCount =
        captureDeclarationCountByRuntimeSourcePath.get(runtimeSourcePath);
      const expectedIdentifierCount =
        identifierCountByRuntimeSourcePath.get(runtimeSourcePath);
      expect(expectedCaptureDeclarationCount).to.not.equal(undefined);
      expect(expectedIdentifierCount).to.not.equal(undefined);
      expect(discoveredCaptureDeclarationCount).to.equal(
        expectedCaptureDeclarationCount,
      );

      if (capturedRuntimeSourcePathSet.has(runtimeSourcePath)) {
        expect(discoveredCaptureDeclarationCount).to.equal(1);
        expect(nonCapturedRuntimeSourcePathSet.has(runtimeSourcePath)).to.equal(
          false,
        );
        expect(expectedIdentifierCount).to.equal(1);
      } else {
        expect(nonCapturedRuntimeSourcePathSet.has(runtimeSourcePath)).to.equal(
          true,
        );
        expect(discoveredCaptureDeclarationCount).to.equal(0);
        expect(expectedIdentifierCount).to.equal(0);
      }
    }

    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ),
    ).to.deep.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ),
    );
  });

  it('keeps sdk Reflect.apply positive-count source sets aligned across capture, identifier, and invocation tables', () => {
    const capturedSourcePaths = [
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
    ].sort(compareLexicographically);

    const captureDeclarationPositiveSourcePaths =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.filter(
        ({ expectedReflectApplyCaptureDeclarationCount }) =>
          expectedReflectApplyCaptureDeclarationCount > 0,
      )
        .map(({ runtimeSourcePath }) => runtimeSourcePath)
        .sort(compareLexicographically);
    const identifierPositiveSourcePaths =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.filter(
        ({ expectedReflectApplyIdentifierReferenceCount }) =>
          expectedReflectApplyIdentifierReferenceCount > 0,
      )
        .map(({ runtimeSourcePath }) => runtimeSourcePath)
        .sort(compareLexicographically);
    const invocationPositiveSourcePaths =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.filter(
        ({ expectedReflectApplyInvocationCount }) =>
          expectedReflectApplyInvocationCount > 0,
      )
        .map(({ runtimeSourcePath }) => runtimeSourcePath)
        .sort(compareLexicographically);

    expect(captureDeclarationPositiveSourcePaths).to.deep.equal(
      capturedSourcePaths,
    );
    expect(identifierPositiveSourcePaths).to.deep.equal(capturedSourcePaths);
    expect(invocationPositiveSourcePaths).to.deep.equal(capturedSourcePaths);

    const nonCapturedSourcePaths = [
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
    ].sort(compareLexicographically);
    const captureDeclarationZeroSourcePaths =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.filter(
        ({ expectedReflectApplyCaptureDeclarationCount }) =>
          expectedReflectApplyCaptureDeclarationCount === 0,
      )
        .map(({ runtimeSourcePath }) => runtimeSourcePath)
        .sort(compareLexicographically);
    const identifierZeroSourcePaths =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.filter(
        ({ expectedReflectApplyIdentifierReferenceCount }) =>
          expectedReflectApplyIdentifierReferenceCount === 0,
      )
        .map(({ runtimeSourcePath }) => runtimeSourcePath)
        .sort(compareLexicographically);
    const invocationZeroSourcePaths =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.filter(
        ({ expectedReflectApplyInvocationCount }) =>
          expectedReflectApplyInvocationCount === 0,
      )
        .map(({ runtimeSourcePath }) => runtimeSourcePath)
        .sort(compareLexicographically);

    expect(captureDeclarationZeroSourcePaths).to.deep.equal(
      nonCapturedSourcePaths,
    );
    expect(identifierZeroSourcePaths).to.deep.equal(nonCapturedSourcePaths);
    expect(invocationZeroSourcePaths).to.deep.equal(nonCapturedSourcePaths);
  });

  it('keeps sdk per-runtime Reflect.apply count relations aligned across capture, identifier, and invocation tables', () => {
    const captureDeclarationCountByRuntimeSourcePath = new Map<string, number>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.map(
        ({
          runtimeSourcePath,
          expectedReflectApplyCaptureDeclarationCount,
        }) => [runtimeSourcePath, expectedReflectApplyCaptureDeclarationCount],
      ),
    );
    const identifierCountByRuntimeSourcePath = new Map<string, number>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.map(
        ({
          runtimeSourcePath,
          expectedReflectApplyIdentifierReferenceCount,
        }) => [runtimeSourcePath, expectedReflectApplyIdentifierReferenceCount],
      ),
    );
    const invocationCountByRuntimeSourcePath = new Map<string, number>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.map(
        ({ runtimeSourcePath, expectedReflectApplyInvocationCount }) => [
          runtimeSourcePath,
          expectedReflectApplyInvocationCount,
        ],
      ),
    );

    for (const runtimeSourcePath of listSdkSquadsNonTestSourceFilePaths()
      .filter((sourcePath) => sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH)
      .sort(compareLexicographically)) {
      const captureDeclarationCount =
        captureDeclarationCountByRuntimeSourcePath.get(runtimeSourcePath);
      const identifierCount =
        identifierCountByRuntimeSourcePath.get(runtimeSourcePath);
      const invocationCount =
        invocationCountByRuntimeSourcePath.get(runtimeSourcePath);
      expect(captureDeclarationCount).to.not.equal(undefined);
      expect(identifierCount).to.not.equal(undefined);
      expect(invocationCount).to.not.equal(undefined);

      expect(captureDeclarationCount).to.equal(identifierCount);
      if (invocationCount === 0) {
        expect(captureDeclarationCount).to.equal(0);
      } else {
        expect(invocationCount).to.be.greaterThanOrEqual(1);
        expect(captureDeclarationCount).to.equal(1);
      }
    }
  });

  it('keeps sdk discovered runtime Reflect.apply count summaries aligned with canonical tables', () => {
    const identifierCountByRuntimeSourcePath = new Map<string, number>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.map(
        ({
          runtimeSourcePath,
          expectedReflectApplyIdentifierReferenceCount,
        }) => [runtimeSourcePath, expectedReflectApplyIdentifierReferenceCount],
      ),
    );
    const invocationCountByRuntimeSourcePath = new Map<string, number>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.map(
        ({ runtimeSourcePath, expectedReflectApplyInvocationCount }) => [
          runtimeSourcePath,
          expectedReflectApplyInvocationCount,
        ],
      ),
    );
    const captureDeclarationCountByRuntimeSourcePath = new Map<string, number>(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.map(
        ({
          runtimeSourcePath,
          expectedReflectApplyCaptureDeclarationCount,
        }) => [runtimeSourcePath, expectedReflectApplyCaptureDeclarationCount],
      ),
    );

    const discoveredRuntimeReflectApplyCountSummaries =
      listSdkSquadsRuntimeReflectApplyCountSummaries();
    for (const {
      runtimeSourcePath,
      reflectApplyIdentifierReferenceCount,
      reflectApplyInvocationCount,
      reflectApplyCaptureDeclarationCount,
    } of discoveredRuntimeReflectApplyCountSummaries) {
      const expectedIdentifierCount =
        identifierCountByRuntimeSourcePath.get(runtimeSourcePath);
      const expectedInvocationCount =
        invocationCountByRuntimeSourcePath.get(runtimeSourcePath);
      const expectedCaptureDeclarationCount =
        captureDeclarationCountByRuntimeSourcePath.get(runtimeSourcePath);
      expect(expectedIdentifierCount).to.not.equal(undefined);
      expect(expectedInvocationCount).to.not.equal(undefined);
      expect(expectedCaptureDeclarationCount).to.not.equal(undefined);
      expect(reflectApplyIdentifierReferenceCount).to.equal(
        expectedIdentifierCount,
      );
      expect(reflectApplyInvocationCount).to.equal(expectedInvocationCount);
      expect(reflectApplyCaptureDeclarationCount).to.equal(
        expectedCaptureDeclarationCount,
      );
    }

    expect(
      discoveredRuntimeReflectApplyCountSummaries.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ),
    ).to.deep.equal(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      ),
    );
  });

  it('keeps sdk runtime Reflect.apply count summaries isolated from caller mutation', () => {
    const baselineRuntimeReflectApplyCountSummaries =
      listSdkSquadsRuntimeReflectApplyCountSummaries();
    expect(baselineRuntimeReflectApplyCountSummaries.length).to.be.greaterThan(
      0,
    );
    expect(Object.isFrozen(baselineRuntimeReflectApplyCountSummaries)).to.equal(
      true,
    );
    for (const summaryEntry of baselineRuntimeReflectApplyCountSummaries) {
      expect(Object.isFrozen(summaryEntry)).to.equal(true);
    }

    const baselineSignatures = baselineRuntimeReflectApplyCountSummaries.map(
      ({
        runtimeSourcePath,
        reflectApplyIdentifierReferenceCount,
        reflectApplyInvocationCount,
        reflectApplyCaptureDeclarationCount,
      }) =>
        `${runtimeSourcePath}:${reflectApplyIdentifierReferenceCount}:${reflectApplyInvocationCount}:${reflectApplyCaptureDeclarationCount}`,
    );

    const callerMutatedSummaries =
      baselineRuntimeReflectApplyCountSummaries as unknown as Array<{
        runtimeSourcePath: string;
        reflectApplyIdentifierReferenceCount: number;
        reflectApplyInvocationCount: number;
        reflectApplyCaptureDeclarationCount: number;
      }>;
    expect(() => {
      callerMutatedSummaries.push({
        runtimeSourcePath: 'src/squads/injected.ts',
        reflectApplyIdentifierReferenceCount: 0,
        reflectApplyInvocationCount: 0,
        reflectApplyCaptureDeclarationCount: 0,
      });
    }).to.throw(TypeError);
    expect(() => {
      callerMutatedSummaries[0].reflectApplyIdentifierReferenceCount = 999;
    }).to.throw(TypeError);
    expect(() => {
      callerMutatedSummaries[0].reflectApplyInvocationCount = 999;
    }).to.throw(TypeError);
    expect(() => {
      callerMutatedSummaries[0].reflectApplyCaptureDeclarationCount = 999;
    }).to.throw(TypeError);

    const subsequentRuntimeReflectApplyCountSummaries =
      listSdkSquadsRuntimeReflectApplyCountSummaries();
    const subsequentSignatures =
      subsequentRuntimeReflectApplyCountSummaries.map(
        ({
          runtimeSourcePath,
          reflectApplyIdentifierReferenceCount,
          reflectApplyInvocationCount,
          reflectApplyCaptureDeclarationCount,
        }) =>
          `${runtimeSourcePath}:${reflectApplyIdentifierReferenceCount}:${reflectApplyInvocationCount}:${reflectApplyCaptureDeclarationCount}`,
      );

    expect(subsequentSignatures).to.deep.equal(baselineSignatures);
    expect(callerMutatedSummaries.length).to.equal(
      subsequentRuntimeReflectApplyCountSummaries.length,
    );
  });

  it('keeps sdk Reflect.apply zero-count totals aligned across runtime tables and inventory', () => {
    const zeroIdentifierCountTotalFromTable =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.filter(
        ({ expectedReflectApplyIdentifierReferenceCount }) =>
          expectedReflectApplyIdentifierReferenceCount === 0,
      ).length;
    const zeroInvocationCountTotalFromTable =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.filter(
        ({ expectedReflectApplyInvocationCount }) =>
          expectedReflectApplyInvocationCount === 0,
      ).length;
    const zeroCaptureDeclarationCountTotalFromTable =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.filter(
        ({ expectedReflectApplyCaptureDeclarationCount }) =>
          expectedReflectApplyCaptureDeclarationCount === 0,
      ).length;

    expect(zeroIdentifierCountTotalFromTable).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_IDENTIFIER_REFERENCE_COUNT,
    );
    expect(zeroInvocationCountTotalFromTable).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_INVOCATION_COUNT,
    );
    expect(zeroCaptureDeclarationCountTotalFromTable).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_CAPTURE_DECLARATION_COUNT,
    );
    expect(zeroIdentifierCountTotalFromTable).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(zeroInvocationCountTotalFromTable).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(zeroCaptureDeclarationCountTotalFromTable).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_IDENTIFIER_REFERENCE_COUNT +
        EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT);
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_INVOCATION_COUNT +
        EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT);
    expect(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_CAPTURE_DECLARATION_COUNT +
        EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT);

    const discoveredRuntimeReflectApplyCountSummaries =
      listSdkSquadsRuntimeReflectApplyCountSummaries();
    const discoveredZeroIdentifierCountTotal =
      discoveredRuntimeReflectApplyCountSummaries.filter(
        ({ reflectApplyIdentifierReferenceCount }) =>
          reflectApplyIdentifierReferenceCount === 0,
      ).length;
    const discoveredZeroInvocationCountTotal =
      discoveredRuntimeReflectApplyCountSummaries.filter(
        ({ reflectApplyInvocationCount }) => reflectApplyInvocationCount === 0,
      ).length;
    const discoveredZeroCaptureDeclarationCountTotal =
      discoveredRuntimeReflectApplyCountSummaries.filter(
        ({ reflectApplyCaptureDeclarationCount }) =>
          reflectApplyCaptureDeclarationCount === 0,
      ).length;

    expect(discoveredZeroIdentifierCountTotal).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_IDENTIFIER_REFERENCE_COUNT,
    );
    expect(discoveredZeroInvocationCountTotal).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_INVOCATION_COUNT,
    );
    expect(discoveredZeroCaptureDeclarationCountTotal).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_CAPTURE_DECLARATION_COUNT,
    );
  });

  it('keeps sdk Reflect.apply positive-count totals aligned across runtime tables and inventory', () => {
    const positiveIdentifierCountTotalFromTable =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.filter(
        ({ expectedReflectApplyIdentifierReferenceCount }) =>
          expectedReflectApplyIdentifierReferenceCount > 0,
      ).length;
    const positiveInvocationCountTotalFromTable =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.filter(
        ({ expectedReflectApplyInvocationCount }) =>
          expectedReflectApplyInvocationCount > 0,
      ).length;
    const positiveCaptureDeclarationCountTotalFromTable =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.filter(
        ({ expectedReflectApplyCaptureDeclarationCount }) =>
          expectedReflectApplyCaptureDeclarationCount > 0,
      ).length;

    expect(positiveIdentifierCountTotalFromTable).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(positiveInvocationCountTotalFromTable).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(positiveCaptureDeclarationCountTotalFromTable).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    );

    const discoveredRuntimeReflectApplyCountSummaries =
      listSdkSquadsRuntimeReflectApplyCountSummaries();
    const discoveredPositiveIdentifierCountTotal =
      discoveredRuntimeReflectApplyCountSummaries.filter(
        ({ reflectApplyIdentifierReferenceCount }) =>
          reflectApplyIdentifierReferenceCount > 0,
      ).length;
    const discoveredPositiveInvocationCountTotal =
      discoveredRuntimeReflectApplyCountSummaries.filter(
        ({ reflectApplyInvocationCount }) => reflectApplyInvocationCount > 0,
      ).length;
    const discoveredPositiveCaptureDeclarationCountTotal =
      discoveredRuntimeReflectApplyCountSummaries.filter(
        ({ reflectApplyCaptureDeclarationCount }) =>
          reflectApplyCaptureDeclarationCount > 0,
      ).length;

    expect(discoveredPositiveIdentifierCountTotal).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(discoveredPositiveInvocationCountTotal).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(discoveredPositiveCaptureDeclarationCountTotal).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
  });

  it('keeps sdk Reflect.apply positive and zero count partitions exhaustive per runtime table', () => {
    const runtimeSourceCount =
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT;

    const identifierPositiveCount =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.filter(
        ({ expectedReflectApplyIdentifierReferenceCount }) =>
          expectedReflectApplyIdentifierReferenceCount > 0,
      ).length;
    const identifierZeroCount =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.filter(
        ({ expectedReflectApplyIdentifierReferenceCount }) =>
          expectedReflectApplyIdentifierReferenceCount === 0,
      ).length;
    expect(identifierPositiveCount + identifierZeroCount).to.equal(
      runtimeSourceCount,
    );

    const invocationPositiveCount =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.filter(
        ({ expectedReflectApplyInvocationCount }) =>
          expectedReflectApplyInvocationCount > 0,
      ).length;
    const invocationZeroCount =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.filter(
        ({ expectedReflectApplyInvocationCount }) =>
          expectedReflectApplyInvocationCount === 0,
      ).length;
    expect(invocationPositiveCount + invocationZeroCount).to.equal(
      runtimeSourceCount,
    );

    const captureDeclarationPositiveCount =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.filter(
        ({ expectedReflectApplyCaptureDeclarationCount }) =>
          expectedReflectApplyCaptureDeclarationCount > 0,
      ).length;
    const captureDeclarationZeroCount =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.filter(
        ({ expectedReflectApplyCaptureDeclarationCount }) =>
          expectedReflectApplyCaptureDeclarationCount === 0,
      ).length;
    expect(
      captureDeclarationPositiveCount + captureDeclarationZeroCount,
    ).to.equal(runtimeSourceCount);
  });

  it('keeps sdk runtime Reflect.apply summary helper partition totals aligned with canonical constants', () => {
    const discoveredRuntimeReflectApplyCountSummaries =
      listSdkSquadsRuntimeReflectApplyCountSummaries();

    const summaryZeroIdentifierCount =
      discoveredRuntimeReflectApplyCountSummaries.filter(
        ({ reflectApplyIdentifierReferenceCount }) =>
          reflectApplyIdentifierReferenceCount === 0,
      ).length;
    const summaryPositiveIdentifierCount =
      discoveredRuntimeReflectApplyCountSummaries.filter(
        ({ reflectApplyIdentifierReferenceCount }) =>
          reflectApplyIdentifierReferenceCount > 0,
      ).length;
    expect(summaryZeroIdentifierCount).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_IDENTIFIER_REFERENCE_COUNT,
    );
    expect(summaryPositiveIdentifierCount).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(
      summaryPositiveIdentifierCount + summaryZeroIdentifierCount,
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT);

    const summaryZeroInvocationCount =
      discoveredRuntimeReflectApplyCountSummaries.filter(
        ({ reflectApplyInvocationCount }) => reflectApplyInvocationCount === 0,
      ).length;
    const summaryPositiveInvocationCount =
      discoveredRuntimeReflectApplyCountSummaries.filter(
        ({ reflectApplyInvocationCount }) => reflectApplyInvocationCount > 0,
      ).length;
    expect(summaryZeroInvocationCount).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_INVOCATION_COUNT,
    );
    expect(summaryPositiveInvocationCount).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(
      summaryPositiveInvocationCount + summaryZeroInvocationCount,
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT);

    const summaryZeroCaptureDeclarationCount =
      discoveredRuntimeReflectApplyCountSummaries.filter(
        ({ reflectApplyCaptureDeclarationCount }) =>
          reflectApplyCaptureDeclarationCount === 0,
      ).length;
    const summaryPositiveCaptureDeclarationCount =
      discoveredRuntimeReflectApplyCountSummaries.filter(
        ({ reflectApplyCaptureDeclarationCount }) =>
          reflectApplyCaptureDeclarationCount > 0,
      ).length;
    expect(summaryZeroCaptureDeclarationCount).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_ZERO_CAPTURE_DECLARATION_COUNT,
    );
    expect(summaryPositiveCaptureDeclarationCount).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(
      summaryPositiveCaptureDeclarationCount +
        summaryZeroCaptureDeclarationCount,
    ).to.equal(EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT);
  });

  it('keeps sdk runtime Reflect.apply summary helper paths sorted unique and runtime-complete', () => {
    const discoveredRuntimeReflectApplyCountSummaries =
      listSdkSquadsRuntimeReflectApplyCountSummaries();
    const discoveredRuntimeSourcePaths =
      discoveredRuntimeReflectApplyCountSummaries.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      );

    expect(new Set(discoveredRuntimeSourcePaths).size).to.equal(
      discoveredRuntimeSourcePaths.length,
    );
    expect(discoveredRuntimeSourcePaths).to.deep.equal(
      [...discoveredRuntimeSourcePaths].sort(compareLexicographically),
    );
    expect(discoveredRuntimeSourcePaths.length).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_RUNTIME_SOURCE_COUNT,
    );
    expect(discoveredRuntimeSourcePaths).to.deep.equal(
      listSdkSquadsNonTestSourceFilePaths()
        .filter((sourcePath) => sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH)
        .sort(compareLexicographically),
    );
  });

  it('keeps sdk runtime Reflect.apply summary helper aligned with direct source counting', () => {
    const directRuntimeReflectApplyCountSummaries =
      listSdkSquadsNonTestSourceFilePaths()
        .filter((sourcePath) => sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH)
        .sort(compareLexicographically)
        .map((runtimeSourcePath) => {
          const absoluteSourcePath = path.join(
            SDK_PACKAGE_ROOT,
            runtimeSourcePath,
          );
          const source = fs.readFileSync(absoluteSourcePath, 'utf8');
          return {
            runtimeSourcePath,
            reflectApplyIdentifierReferenceCount: countOccurrences(
              source,
              REFLECT_APPLY_IDENTIFIER_REFERENCE_STATEMENT,
            ),
            reflectApplyInvocationCount: countOccurrences(
              source,
              REFLECT_APPLY_INVOCATION_STATEMENT,
            ),
            reflectApplyCaptureDeclarationCount: countOccurrences(
              source,
              REFLECT_APPLY_CAPTURE_DECLARATION_STATEMENT,
            ),
          };
        });
    const discoveredRuntimeReflectApplyCountSummaries =
      listSdkSquadsRuntimeReflectApplyCountSummaries();

    expect(discoveredRuntimeReflectApplyCountSummaries).to.deep.equal(
      directRuntimeReflectApplyCountSummaries,
    );
  });

  it('keeps sdk Reflect.apply identifier and REFLECT_APPLY totals aligned with runtime sources', () => {
    const identifierReferenceCountTotalFromTable =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.reduce(
        (sum, { expectedReflectApplyIdentifierReferenceCount }) =>
          sum + expectedReflectApplyIdentifierReferenceCount,
        0,
      );
    const invocationCountTotalFromTable =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.reduce(
        (sum, { expectedReflectApplyInvocationCount }) =>
          sum + expectedReflectApplyInvocationCount,
        0,
      );
    const captureDeclarationCountTotalFromTable =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.reduce(
        (sum, { expectedReflectApplyCaptureDeclarationCount }) =>
          sum + expectedReflectApplyCaptureDeclarationCount,
        0,
      );
    expect(identifierReferenceCountTotalFromTable).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNT,
    );
    expect(invocationCountTotalFromTable).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNT,
    );
    expect(captureDeclarationCountTotalFromTable).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNT,
    );
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS.length,
    ).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_COUNT,
    );
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS.length,
    ).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_COUNT,
    );

    const discoveredRuntimeReflectApplyCountSummaries =
      listSdkSquadsRuntimeReflectApplyCountSummaries();
    const discoveredIdentifierReferenceCountTotal =
      discoveredRuntimeReflectApplyCountSummaries.reduce(
        (sum, { reflectApplyIdentifierReferenceCount }) =>
          sum + reflectApplyIdentifierReferenceCount,
        0,
      );
    const discoveredInvocationCountTotal =
      discoveredRuntimeReflectApplyCountSummaries.reduce(
        (sum, { reflectApplyInvocationCount }) =>
          sum + reflectApplyInvocationCount,
        0,
      );
    const discoveredCaptureDeclarationCountTotal =
      discoveredRuntimeReflectApplyCountSummaries.reduce(
        (sum, { reflectApplyCaptureDeclarationCount }) =>
          sum + reflectApplyCaptureDeclarationCount,
        0,
      );

    expect(discoveredIdentifierReferenceCountTotal).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNT,
    );
    expect(discoveredInvocationCountTotal).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNT,
    );
    expect(discoveredCaptureDeclarationCountTotal).to.equal(
      EXPECTED_TOTAL_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNT,
    );
  });

  it('keeps Reflect.apply mutation coverage constants deeply frozen', () => {
    expect(
      Object.isFrozen(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS,
      ),
    ).to.equal(true);
    expect(
      Object.isFrozen(EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS),
    ).to.equal(true);
    expect(
      Object.isFrozen(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
      ),
    ).to.equal(true);
    expect(
      Object.isFrozen(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
      ),
    ).to.equal(true);
    expect(
      Object.isFrozen(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS,
      ),
    ).to.equal(true);
    expect(
      Object.isFrozen(EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS),
    ).to.equal(true);
    expect(
      Object.isFrozen(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE,
      ),
    ).to.equal(true);
    for (const countEntry of EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS) {
      expect(Object.isFrozen(countEntry)).to.equal(true);
    }
    for (const runtimeEntry of EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE) {
      expect(Object.isFrozen(runtimeEntry)).to.equal(true);
      expect(Object.isFrozen(runtimeEntry.coveringTestPaths)).to.equal(true);
    }
    for (const countEntry of EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS) {
      expect(Object.isFrozen(countEntry)).to.equal(true);
    }
    for (const countEntry of EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS) {
      expect(Object.isFrozen(countEntry)).to.equal(true);
    }
    for (const countEntry of EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS) {
      expect(Object.isFrozen(countEntry)).to.equal(true);
    }

    const baselineMutationTestFilePaths = [
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS,
    ];
    const baselineCaptureRuntimeSourcePaths = [
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
    ];
    const baselineNonCaptureRuntimeSourcePaths = [
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
    ];
    const baselineRuntimeReflectApplyIdentifierReferenceCounts =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.map(
        ({ runtimeSourcePath, expectedReflectApplyIdentifierReferenceCount }) =>
          `${runtimeSourcePath}:${expectedReflectApplyIdentifierReferenceCount}`,
      );
    const baselineRuntimeReflectApplyInvocationCounts =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.map(
        ({ runtimeSourcePath, expectedReflectApplyInvocationCount }) =>
          `${runtimeSourcePath}:${expectedReflectApplyInvocationCount}`,
      );
    const baselineRuntimeReflectApplyCaptureDeclarationCounts =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.map(
        ({ runtimeSourcePath, expectedReflectApplyCaptureDeclarationCount }) =>
          `${runtimeSourcePath}:${expectedReflectApplyCaptureDeclarationCount}`,
      );
    const baselineCountSignatures =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS.map(
        ({ testPath, expectedMutationTestCount }) =>
          `${testPath}:${expectedMutationTestCount}`,
      );
    const baselineRuntimeCoverageSignatures =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE.map(
        ({ runtimeSourcePath, coveringTestPaths }) =>
          `${runtimeSourcePath}->${[...coveringTestPaths].join(',')}`,
      );

    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS as unknown as string[]
      ).push('src/squads/injected.test.ts');
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS as unknown as string[]
      )[0] = 'src/squads/mutated.test.ts';
    }).to.throw();

    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS as unknown as Array<{
          testPath: string;
          expectedMutationTestCount: number;
        }>
      ).push({
        testPath: 'src/squads/injected.test.ts',
        expectedMutationTestCount: 1,
      });
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS as unknown as Array<{
          testPath: string;
          expectedMutationTestCount: number;
        }>
      )[0].expectedMutationTestCount = 99;
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS as unknown as string[]
      ).push('src/squads/injected.ts');
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS as unknown as string[]
      )[0] = 'src/squads/mutated.ts';
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS as unknown as string[]
      ).push('src/squads/injected.ts');
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS as unknown as string[]
      )[0] = 'src/squads/mutated.ts';
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS as unknown as Array<{
          runtimeSourcePath: string;
          expectedReflectApplyIdentifierReferenceCount: number;
        }>
      ).push({
        runtimeSourcePath: 'src/squads/injected.ts',
        expectedReflectApplyIdentifierReferenceCount: 1,
      });
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS as unknown as Array<{
          runtimeSourcePath: string;
          expectedReflectApplyIdentifierReferenceCount: number;
        }>
      )[0].expectedReflectApplyIdentifierReferenceCount = 99;
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS as unknown as Array<{
          runtimeSourcePath: string;
          expectedReflectApplyInvocationCount: number;
        }>
      ).push({
        runtimeSourcePath: 'src/squads/injected.ts',
        expectedReflectApplyInvocationCount: 1,
      });
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS as unknown as Array<{
          runtimeSourcePath: string;
          expectedReflectApplyInvocationCount: number;
        }>
      )[0].expectedReflectApplyInvocationCount = 99;
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS as unknown as Array<{
          runtimeSourcePath: string;
          expectedReflectApplyCaptureDeclarationCount: number;
        }>
      ).push({
        runtimeSourcePath: 'src/squads/injected.ts',
        expectedReflectApplyCaptureDeclarationCount: 1,
      });
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS as unknown as Array<{
          runtimeSourcePath: string;
          expectedReflectApplyCaptureDeclarationCount: number;
        }>
      )[0].expectedReflectApplyCaptureDeclarationCount = 99;
    }).to.throw();

    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE as unknown as Array<{
          runtimeSourcePath: string;
          coveringTestPaths: readonly string[];
        }>
      ).push({
        runtimeSourcePath: 'src/squads/injected.ts',
        coveringTestPaths: ['src/squads/injected.test.ts'],
      });
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE as unknown as Array<{
          runtimeSourcePath: string;
          coveringTestPaths: readonly string[];
        }>
      )[0].runtimeSourcePath = 'src/squads/mutated.ts';
    }).to.throw();
    expect(() => {
      (
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE as unknown as Array<{
          runtimeSourcePath: string;
          coveringTestPaths: string[];
        }>
      )[0].coveringTestPaths.push('src/squads/injected.test.ts');
    }).to.throw();

    expect([
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS,
    ]).to.deep.equal(baselineMutationTestFilePaths);
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS.map(
        ({ testPath, expectedMutationTestCount }) =>
          `${testPath}:${expectedMutationTestCount}`,
      ),
    ).to.deep.equal(baselineCountSignatures);
    expect([
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURED_RUNTIME_SOURCE_PATHS,
    ]).to.deep.equal(baselineCaptureRuntimeSourcePaths);
    expect([
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_NON_CAPTURED_RUNTIME_SOURCE_PATHS,
    ]).to.deep.equal(baselineNonCaptureRuntimeSourcePaths);
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_IDENTIFIER_REFERENCE_COUNTS.map(
        ({ runtimeSourcePath, expectedReflectApplyIdentifierReferenceCount }) =>
          `${runtimeSourcePath}:${expectedReflectApplyIdentifierReferenceCount}`,
      ),
    ).to.deep.equal(baselineRuntimeReflectApplyIdentifierReferenceCounts);
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_INVOCATION_COUNTS.map(
        ({ runtimeSourcePath, expectedReflectApplyInvocationCount }) =>
          `${runtimeSourcePath}:${expectedReflectApplyInvocationCount}`,
      ),
    ).to.deep.equal(baselineRuntimeReflectApplyInvocationCounts);
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_CAPTURE_DECLARATION_COUNTS.map(
        ({ runtimeSourcePath, expectedReflectApplyCaptureDeclarationCount }) =>
          `${runtimeSourcePath}:${expectedReflectApplyCaptureDeclarationCount}`,
      ),
    ).to.deep.equal(baselineRuntimeReflectApplyCaptureDeclarationCounts);
    expect(
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE.map(
        ({ runtimeSourcePath, coveringTestPaths }) =>
          `${runtimeSourcePath}->${[...coveringTestPaths].join(',')}`,
      ),
    ).to.deep.equal(baselineRuntimeCoverageSignatures);
  });

  it('keeps Reflect.apply runtime coverage test-path set aligned with mutation-test tables', () => {
    const runtimeCoverageTestPathSet = new Set<string>();
    for (const {
      coveringTestPaths,
    } of EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE) {
      for (const coveringTestPath of coveringTestPaths) {
        runtimeCoverageTestPathSet.add(coveringTestPath);
      }
    }

    const runtimeCoverageTestPaths = [...runtimeCoverageTestPathSet].sort(
      compareLexicographically,
    );
    const expectedMutationTestPaths = [
      ...EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_FILE_PATHS,
    ].sort(compareLexicographically);
    const countedMutationTestPaths = [
      ...new Set(
        EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_TEST_COUNTS.map(
          ({ testPath }) => testPath,
        ),
      ),
    ].sort(compareLexicographically);

    expect(runtimeCoverageTestPaths).to.deep.equal(expectedMutationTestPaths);
    expect(runtimeCoverageTestPaths).to.deep.equal(countedMutationTestPaths);
  });

  it('keeps sdk Reflect.apply runtime coverage map aligned with non-barrel runtime source set', () => {
    const mappedRuntimeSourcePaths =
      EXPECTED_SDK_SQUADS_REFLECT_APPLY_MUTATION_RUNTIME_COVERAGE.map(
        ({ runtimeSourcePath }) => runtimeSourcePath,
      );
    const expectedCoveredRuntimeSourcePaths =
      listSdkSquadsNonTestSourceFilePaths()
        .filter((sourcePath) => sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH)
        .sort(compareLexicographically);

    expect(mappedRuntimeSourcePaths).to.deep.equal(
      expectedCoveredRuntimeSourcePaths,
    );
  });

  it('keeps sdk discovered squads test files aligned with canonical test file paths', () => {
    const discoveredSquadsTestPaths = listSdkSquadsTestFilePaths();
    expect(discoveredSquadsTestPaths).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_TEST_FILE_PATHS,
    ]);
  });

  it('keeps sdk squads test globs excluding non-test squads source files', () => {
    const nonTestSquadsSourcePaths = listSdkSquadsNonTestSourceFilePaths();
    expect(
      nonTestSquadsSourcePaths.length,
      'Expected at least one sdk squads non-test source file',
    ).to.be.greaterThan(0);

    for (const nonTestPath of nonTestSquadsSourcePaths) {
      assertSdkSquadsNonTestSourcePathShape(
        nonTestPath,
        'discovered sdk squads non-test source path',
      );
      expect(
        SDK_SQUADS_TEST_TOKEN_PATHS.some((globPattern) =>
          matchesSingleAsteriskGlob(nonTestPath, globPattern),
        ),
        `Expected sdk squads test command glob to exclude non-test source path: ${nonTestPath}`,
      ).to.equal(false);
    }
  });

  it('keeps sdk squads test files flat for non-recursive squads test glob', () => {
    const topLevelDiscoveredTestPaths = listSdkSquadsTestFilePaths();
    const recursivelyDiscoveredTestPaths =
      listSdkSquadsTestFilePathsRecursively(SDK_SQUADS_SOURCE_DIR);
    expect(recursivelyDiscoveredTestPaths.length).to.be.greaterThan(0);
    expect(topLevelDiscoveredTestPaths).to.deep.equal(
      recursivelyDiscoveredTestPaths,
    );
  });

  it('keeps sdk squads non-test sources flat for top-level discovery helper', () => {
    const topLevelDiscoveredNonTestSourcePaths =
      listSdkSquadsNonTestSourceFilePaths();
    const recursivelyDiscoveredNonTestSourcePaths =
      listSdkSquadsNonTestSourceFilePathsRecursively(SDK_SQUADS_SOURCE_DIR);
    expect(recursivelyDiscoveredNonTestSourcePaths.length).to.be.greaterThan(0);
    expect(topLevelDiscoveredNonTestSourcePaths).to.deep.equal(
      recursivelyDiscoveredNonTestSourcePaths,
    );
  });

  it('keeps sdk squads TypeScript discovery partitioned into test and non-test sets', () => {
    const recursivelyDiscoveredTestPaths = [
      ...listSdkSquadsTestFilePathsRecursively(SDK_SQUADS_SOURCE_DIR),
    ];
    const recursivelyDiscoveredNonTestSourcePaths = [
      ...listSdkSquadsNonTestSourceFilePathsRecursively(SDK_SQUADS_SOURCE_DIR),
    ];
    const recursivelyDiscoveredTypeScriptPaths = [
      ...listSdkSquadsTypeScriptPathsRecursively(SDK_SQUADS_SOURCE_DIR),
    ];

    expect(
      recursivelyDiscoveredTestPaths.length,
      'Expected at least one recursively discovered sdk squads test path',
    ).to.be.greaterThan(0);
    expect(
      recursivelyDiscoveredNonTestSourcePaths.length,
      'Expected at least one recursively discovered sdk squads non-test path',
    ).to.be.greaterThan(0);

    const testPathSet = new Set(recursivelyDiscoveredTestPaths);
    const nonTestPathSet = new Set(recursivelyDiscoveredNonTestSourcePaths);

    for (const nonTestPath of nonTestPathSet) {
      assertSdkSquadsNonTestSourcePathShape(
        nonTestPath,
        'recursively discovered sdk squads non-test source path',
      );
    }
    for (const testPath of testPathSet) {
      expect(nonTestPathSet.has(testPath)).to.equal(false);
    }

    expect(new Set(recursivelyDiscoveredTypeScriptPaths).size).to.equal(
      recursivelyDiscoveredTypeScriptPaths.length,
    );
    expect(recursivelyDiscoveredTypeScriptPaths).to.deep.equal(
      [...recursivelyDiscoveredTypeScriptPaths].sort(compareLexicographically),
    );
    expect(
      [
        ...recursivelyDiscoveredTestPaths,
        ...recursivelyDiscoveredNonTestSourcePaths,
      ].sort(compareLexicographically),
    ).to.deep.equal(recursivelyDiscoveredTypeScriptPaths);
  });

  it('keeps sdk discovered squads file paths resolving to files', () => {
    const discoveredTestPaths = listSdkSquadsTestFilePaths();
    const discoveredNonTestSourcePaths = listSdkSquadsNonTestSourceFilePaths();
    const discoveredAllTypeScriptPaths =
      listSdkSquadsTypeScriptPathsRecursively(SDK_SQUADS_SOURCE_DIR);

    assertRelativePathsResolveToFiles(
      discoveredTestPaths,
      'discovered sdk squads test',
    );
    assertRelativePathsResolveToFiles(
      discoveredNonTestSourcePaths,
      'discovered sdk squads non-test source',
    );
    assertRelativePathsResolveToFiles(
      discoveredAllTypeScriptPaths,
      'discovered sdk squads TypeScript',
    );
  });

  it('keeps sdk squads non-test sources partitioned between barrel exports and internal modules', () => {
    const discoveredNonTestSourcePaths = listSdkSquadsNonTestSourceFilePaths();
    const barrelExportedSourcePaths = listSquadsBarrelExportedSourcePaths();
    assertRelativePathsResolveToFiles(
      discoveredNonTestSourcePaths,
      'discovered sdk squads non-test source',
    );
    assertRelativePathsResolveToFiles(
      barrelExportedSourcePaths,
      'barrel-exported sdk squads source',
    );
    expect(new Set(barrelExportedSourcePaths).size).to.equal(
      barrelExportedSourcePaths.length,
    );
    expect(barrelExportedSourcePaths).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS,
    ]);
    for (const barrelExportedSourcePath of barrelExportedSourcePaths) {
      assertSdkSquadsNonTestSourcePathShape(
        barrelExportedSourcePath,
        'sdk squads barrel-exported source path',
      );
    }
    const nonExportedSourcePaths = discoveredNonTestSourcePaths
      .filter(
        (sourcePath) =>
          sourcePath !== SDK_SQUADS_INDEX_SOURCE_PATH &&
          !barrelExportedSourcePaths.includes(sourcePath),
      )
      .sort(compareLexicographically);
    expect(nonExportedSourcePaths).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS,
    ]);
    expect(
      [
        ...barrelExportedSourcePaths,
        ...nonExportedSourcePaths,
        SDK_SQUADS_INDEX_SOURCE_PATH,
      ].sort(compareLexicographically),
    ).to.deep.equal(
      [...discoveredNonTestSourcePaths].sort(compareLexicographically),
    );
  });

  it('keeps expected sdk squads barrel-exported source paths normalized and deduplicated', () => {
    expect(
      Object.isFrozen(EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS),
    ).to.equal(true);
    expect(
      [...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS].sort(
        compareLexicographically,
      ),
    ).to.deep.equal([...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS]);
    expect(
      new Set(EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS).size,
    ).to.equal(EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS.length);
    for (const sourcePath of EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS) {
      assertSdkSquadsNonTestSourcePathShape(
        sourcePath,
        'expected sdk squads barrel-exported source path constant',
      );
    }
  });

  it('keeps expected canonical sdk squads barrel-exported source paths', () => {
    expect(EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS).to.deep.equal([
      'src/squads/config.ts',
      'src/squads/error-format.ts',
      'src/squads/transaction-reader.ts',
      'src/squads/utils.ts',
    ]);
  });

  it('keeps expected canonical sdk squads test token paths', () => {
    expect(SDK_SQUADS_TEST_TOKEN_PATHS).to.deep.equal(['src/squads/*.test.ts']);
  });

  it('keeps expected canonical sdk squads barrel export statements', () => {
    expect(EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS).to.deep.equal([
      "export * from './config.js';",
      "export * from './utils.js';",
      "export * from './transaction-reader.js';",
      "export * from './error-format.js';",
    ]);
  });

  it('keeps squads barrel export statements aligned with exported source-path constants', () => {
    const exportedSourcePathsFromStatements =
      EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS.map((statement) =>
        statement
          .replace("export * from './", 'src/squads/')
          .replace(".js';", '.ts'),
      ).sort(compareLexicographically);
    expect(exportedSourcePathsFromStatements).to.deep.equal([
      ...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS,
    ]);
  });

  it('keeps expected canonical sdk squads internal source paths', () => {
    expect(
      EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS,
    ).to.deep.equal([
      'src/squads/inspection.ts',
      'src/squads/provider.ts',
      'src/squads/validation.ts',
    ]);
  });

  it('keeps expected canonical sdk squads index source path', () => {
    expect(SDK_SQUADS_INDEX_SOURCE_PATH).to.equal('src/squads/index.ts');
  });

  it('keeps sdk squads source-role constants normalized and disjoint', () => {
    expect(Object.isFrozen(EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS)).to.equal(
      true,
    );
    expect(
      Object.isFrozen(EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS),
    ).to.equal(true);

    expect(new Set(EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS).size).to.equal(
      EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS.length,
    );
    for (const exportStatement of EXPECTED_SQUADS_BARREL_EXPORT_STATEMENTS) {
      expect(exportStatement).to.equal(exportStatement.trim());
      expect(/\s{2,}/.test(exportStatement)).to.equal(false);
      expect(exportStatement.startsWith("export * from './")).to.equal(true);
      expect(exportStatement.endsWith(".js';")).to.equal(true);
    }

    expect(
      new Set(EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS).size,
    ).to.equal(EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS.length);
    for (const sourcePath of EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS) {
      assertSdkSquadsNonTestSourcePathShape(
        sourcePath,
        'expected sdk squads internal non-exported source path constant',
      );
    }

    const exportedSourcePathSet = new Set(
      EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS,
    );
    for (const internalSourcePath of EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS) {
      expect(exportedSourcePathSet.has(internalSourcePath)).to.equal(false);
    }
  });

  it('keeps sdk squads source-path constants isolated from caller mutation', () => {
    const baselineBarrelExportedPaths = [
      ...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS,
    ];
    const callerMutatedBarrelExportedPaths = [
      ...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS,
    ];
    callerMutatedBarrelExportedPaths.pop();
    const subsequentBarrelExportedPaths = [
      ...EXPECTED_SDK_SQUADS_BARREL_EXPORTED_SOURCE_PATHS,
    ];
    expect(callerMutatedBarrelExportedPaths).to.not.deep.equal(
      baselineBarrelExportedPaths,
    );
    expect(subsequentBarrelExportedPaths).to.deep.equal(
      baselineBarrelExportedPaths,
    );

    const baselineInternalSourcePaths = [
      ...EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS,
    ];
    const callerMutatedInternalSourcePaths = [
      ...EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS,
    ];
    callerMutatedInternalSourcePaths.pop();
    const subsequentInternalSourcePaths = [
      ...EXPECTED_SDK_SQUADS_INTERNAL_NON_EXPORTED_SOURCE_PATHS,
    ];
    expect(callerMutatedInternalSourcePaths).to.not.deep.equal(
      baselineInternalSourcePaths,
    );
    expect(subsequentInternalSourcePaths).to.deep.equal(
      baselineInternalSourcePaths,
    );
  });

  it('keeps sdk squads source directory flat without nested subdirectories', () => {
    expect(
      listSdkSquadsSubdirectoryPathsRecursively(SDK_SQUADS_SOURCE_DIR),
    ).to.deep.equal([]);
  });

  it('keeps process and console decoupling patterns covering bracket optional and parenthesized access', () => {
    expect(
      PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test("process?.['env']"),
    ).to.equal(true);
    expect(
      PARENTHESIZED_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        "(process)?.['env']",
      ),
    ).to.equal(true);
    expect(
      PARENTHESIZED_PROCESS_REFERENCE_PATTERN.test("(process)['stdout']"),
    ).to.equal(true);
    expect(
      CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test("console?.['warn']('x')"),
    ).to.equal(true);
    expect(
      PARENTHESIZED_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        "(console)?.['warn']('x')",
      ),
    ).to.equal(true);
    expect(
      PARENTHESIZED_CONSOLE_REFERENCE_PATTERN.test("(console)['log']('x')"),
    ).to.equal(true);
    expect(
      GLOBAL_PROCESS_DESTRUCTURE_REFERENCE_PATTERN.test(
        'const { process } = globalThis',
      ),
    ).to.equal(true);
    expect(
      GLOBAL_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        "globalThis?.['process']",
      ),
    ).to.equal(true);
    expect(
      PARENTHESIZED_GLOBAL_PROCESS_REFERENCE_PATTERN.test(
        "(window)['process']",
      ),
    ).to.equal(true);
    expect(
      PARENTHESIZED_GLOBAL_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        '(globalThis)?.process',
      ),
    ).to.equal(true);
    expect(SELF_PROCESS_REFERENCE_PATTERN.test('self.process')).to.equal(true);
    expect(
      SELF_PROCESS_BRACKET_REFERENCE_PATTERN.test("self['process']"),
    ).to.equal(true);
    expect(
      SELF_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test("self?.['process']"),
    ).to.equal(true);
    expect(
      PARENTHESIZED_SELF_PROCESS_REFERENCE_PATTERN.test('(self).process'),
    ).to.equal(true);
    expect(
      PARENTHESIZED_SELF_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        "(self)?.['process']",
      ),
    ).to.equal(true);
    expect(
      GLOBAL_CONSOLE_DESTRUCTURE_REFERENCE_PATTERN.test(
        'const { console } = window',
      ),
    ).to.equal(true);
    expect(
      GLOBAL_PROCESS_DESTRUCTURE_REFERENCE_PATTERN.test(
        'const { process } = self',
      ),
    ).to.equal(true);
    expect(
      GLOBAL_CONSOLE_DESTRUCTURE_REFERENCE_PATTERN.test(
        'const { console } = self',
      ),
    ).to.equal(true);
    expect(
      GLOBAL_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test('global?.console'),
    ).to.equal(true);
    expect(
      PARENTHESIZED_GLOBAL_CONSOLE_REFERENCE_PATTERN.test(
        '(globalThis).console',
      ),
    ).to.equal(true);
    expect(
      PARENTHESIZED_GLOBAL_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        "(window)?.['console']",
      ),
    ).to.equal(true);
    expect(SELF_CONSOLE_REFERENCE_PATTERN.test('self.console')).to.equal(true);
    expect(
      SELF_CONSOLE_BRACKET_REFERENCE_PATTERN.test('self["console"]'),
    ).to.equal(true);
    expect(
      SELF_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test('self?.console'),
    ).to.equal(true);
    expect(
      PARENTHESIZED_SELF_CONSOLE_REFERENCE_PATTERN.test('(self)["console"]'),
    ).to.equal(true);
    expect(
      PARENTHESIZED_SELF_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        '(self)?.console',
      ),
    ).to.equal(true);

    expect(
      PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test('processor?.env'),
    ).to.equal(false);
    expect(
      PARENTHESIZED_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        '(processes)?.env',
      ),
    ).to.equal(false);
    expect(
      PARENTHESIZED_PROCESS_REFERENCE_PATTERN.test('(processes).env'),
    ).to.equal(false);
    expect(
      CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test("consoles?.['warn']"),
    ).to.equal(false);
    expect(
      PARENTHESIZED_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        "(consoles)?.['warn']('x')",
      ),
    ).to.equal(false);
    expect(
      PARENTHESIZED_CONSOLE_REFERENCE_PATTERN.test("(consoles)['log']"),
    ).to.equal(false);
    expect(
      GLOBAL_PROCESS_DESTRUCTURE_REFERENCE_PATTERN.test(
        'const { processor } = globalThis',
      ),
    ).to.equal(false);
    expect(
      GLOBAL_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        'globalThis?.processor',
      ),
    ).to.equal(false);
    expect(
      PARENTHESIZED_GLOBAL_PROCESS_REFERENCE_PATTERN.test('(windows).process'),
    ).to.equal(false);
    expect(
      PARENTHESIZED_GLOBAL_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        '(globalThiss)?.process',
      ),
    ).to.equal(false);
    expect(SELF_PROCESS_REFERENCE_PATTERN.test('shelf.process')).to.equal(
      false,
    );
    expect(
      SELF_PROCESS_BRACKET_REFERENCE_PATTERN.test("shelf['process']"),
    ).to.equal(false);
    expect(
      SELF_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test('shelf?.process'),
    ).to.equal(false);
    expect(
      PARENTHESIZED_SELF_PROCESS_REFERENCE_PATTERN.test('(shelf).process'),
    ).to.equal(false);
    expect(
      PARENTHESIZED_SELF_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        '(shelf)?.process',
      ),
    ).to.equal(false);
    expect(
      GLOBAL_CONSOLE_DESTRUCTURE_REFERENCE_PATTERN.test(
        'const { consoles } = window',
      ),
    ).to.equal(false);
    expect(
      GLOBAL_PROCESS_DESTRUCTURE_REFERENCE_PATTERN.test(
        'const { processor } = self',
      ),
    ).to.equal(false);
    expect(
      GLOBAL_CONSOLE_DESTRUCTURE_REFERENCE_PATTERN.test(
        'const { consoles } = self',
      ),
    ).to.equal(false);
    expect(
      GLOBAL_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test('global?.consoles'),
    ).to.equal(false);
    expect(
      PARENTHESIZED_GLOBAL_CONSOLE_REFERENCE_PATTERN.test(
        '(globalThiss).console',
      ),
    ).to.equal(false);
    expect(
      PARENTHESIZED_GLOBAL_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        '(windows)?.console',
      ),
    ).to.equal(false);
    expect(SELF_CONSOLE_REFERENCE_PATTERN.test('shelf.console')).to.equal(
      false,
    );
    expect(
      SELF_CONSOLE_BRACKET_REFERENCE_PATTERN.test('shelf["console"]'),
    ).to.equal(false);
    expect(
      SELF_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test('shelf?.console'),
    ).to.equal(false);
    expect(
      PARENTHESIZED_SELF_CONSOLE_REFERENCE_PATTERN.test('(shelf).console'),
    ).to.equal(false);
    expect(
      PARENTHESIZED_SELF_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
        '(shelf)?.console',
      ),
    ).to.equal(false);
  });

  it('keeps sdk squads runtime sources decoupled from infra and filesystem env wiring', () => {
    const runtimeSourcePaths = listSdkSquadsNonTestSourceFilePaths();
    expect(runtimeSourcePaths.length).to.be.greaterThan(0);

    for (const runtimeSourcePath of runtimeSourcePaths) {
      const runtimeSource = fs.readFileSync(
        path.join(SDK_PACKAGE_ROOT, runtimeSourcePath),
        'utf8',
      );

      expect(
        INFRA_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid infra references: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        FILESYSTEM_IMPORT_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid filesystem imports: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_ENV_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.env coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_ARGV_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.argv coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_CWD_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.cwd coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_EXIT_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.exit coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_STDIN_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.stdin coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_STDOUT_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.stdout coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_STDERR_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process.stderr coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_BRACKET_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process['*'] coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_DESTRUCTURE_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process destructuring coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_ALIAS_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process alias coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid process optional-chaining coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PARENTHESIZED_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
          runtimeSource,
        ),
        `Expected sdk squads runtime source to avoid parenthesized process optional-chaining coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PARENTHESIZED_PROCESS_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid parenthesized process coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        GLOBAL_PROCESS_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid global process coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        GLOBAL_PROCESS_BRACKET_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid global['process'] coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        GLOBAL_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid optional global/window process coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PARENTHESIZED_GLOBAL_PROCESS_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid parenthesized global/window process coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PARENTHESIZED_GLOBAL_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
          runtimeSource,
        ),
        `Expected sdk squads runtime source to avoid parenthesized optional global/window process coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        WINDOW_PROCESS_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid window.process coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        WINDOW_PROCESS_BRACKET_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid window['process'] coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        SELF_PROCESS_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid self.process coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        SELF_PROCESS_BRACKET_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid self['process'] coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        SELF_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid optional self process coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PARENTHESIZED_SELF_PROCESS_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid parenthesized self process coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PARENTHESIZED_SELF_PROCESS_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
          runtimeSource,
        ),
        `Expected sdk squads runtime source to avoid parenthesized optional self process coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        GLOBAL_PROCESS_DESTRUCTURE_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid global/window process destructuring coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        CONSOLE_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid direct console usage: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        CONSOLE_DESTRUCTURE_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid console destructuring coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        CONSOLE_ALIAS_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid console alias coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid console optional-chaining coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PARENTHESIZED_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
          runtimeSource,
        ),
        `Expected sdk squads runtime source to avoid parenthesized console optional-chaining coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PARENTHESIZED_CONSOLE_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid parenthesized console coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        GLOBAL_CONSOLE_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid global console usage: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        GLOBAL_CONSOLE_BRACKET_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid global['console'] coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        GLOBAL_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid optional global/window console coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PARENTHESIZED_GLOBAL_CONSOLE_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid parenthesized global/window console coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PARENTHESIZED_GLOBAL_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
          runtimeSource,
        ),
        `Expected sdk squads runtime source to avoid parenthesized optional global/window console coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        WINDOW_CONSOLE_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid window.console coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        WINDOW_CONSOLE_BRACKET_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid window['console'] coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        SELF_CONSOLE_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid self.console coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        SELF_CONSOLE_BRACKET_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid self['console'] coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        SELF_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid optional self console coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PARENTHESIZED_SELF_CONSOLE_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid parenthesized self console coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        PARENTHESIZED_SELF_CONSOLE_OPTIONAL_CHAIN_REFERENCE_PATTERN.test(
          runtimeSource,
        ),
        `Expected sdk squads runtime source to avoid parenthesized optional self console coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        GLOBAL_CONSOLE_DESTRUCTURE_REFERENCE_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid global/window console destructuring coupling: ${runtimeSourcePath}`,
      ).to.equal(false);
      expect(
        CLI_GLUE_IMPORT_PATTERN.test(runtimeSource),
        `Expected sdk squads runtime source to avoid infra CLI glue imports: ${runtimeSourcePath}`,
      ).to.equal(false);
    }
  });

  it('keeps sdk squads runtime source hardened against unsafe member-access patterns', () => {
    const runtimeSourcePaths = listSdkSquadsNonTestSourceFilePaths();
    expect(runtimeSourcePaths.length).to.be.greaterThan(0);

    for (const runtimeSourcePath of runtimeSourcePaths) {
      const runtimeSource = fs.readFileSync(
        path.join(SDK_PACKAGE_ROOT, runtimeSourcePath),
        'utf8',
      );

      for (const { label, pattern } of FORBIDDEN_RUNTIME_HARDENING_PATTERNS) {
        expect(
          pattern.test(runtimeSource),
          `Expected sdk squads runtime source to avoid ${label}: ${runtimeSourcePath}`,
        ).to.equal(false);
      }
    }
  });

  it('keeps forbidden runtime hardening patterns normalized and deduplicated', () => {
    expect(FORBIDDEN_RUNTIME_HARDENING_PATTERNS).to.have.length(
      EXPECTED_FORBIDDEN_RUNTIME_HARDENING_PATTERN_COUNT,
    );
    expect(FORBIDDEN_RUNTIME_HARDENING_PATTERNS.length).to.be.greaterThan(0);

    const seenLabels = new Set<string>();
    const seenRegexes = new Set<string>();

    for (const { label, pattern } of FORBIDDEN_RUNTIME_HARDENING_PATTERNS) {
      expect(label.trim().length).to.be.greaterThan(0);
      expect(
        seenLabels.has(label),
        `Expected forbidden-pattern labels to be unique: ${label}`,
      ).to.equal(false);
      seenLabels.add(label);

      const regexSignature = `/${pattern.source}/${pattern.flags}`;
      expect(
        seenRegexes.has(regexSignature),
        `Expected forbidden-pattern regexes to be unique: ${regexSignature}`,
      ).to.equal(false);
      seenRegexes.add(regexSignature);
    }
  });

  it('keeps required forbidden runtime hardening labels covered', () => {
    expect(REQUIRED_FORBIDDEN_RUNTIME_HARDENING_PATTERN_LABELS).to.have.length(
      EXPECTED_REQUIRED_FORBIDDEN_RUNTIME_HARDENING_LABEL_COUNT,
    );
    const forbiddenPatternLabels = new Set<string>(
      FORBIDDEN_RUNTIME_HARDENING_PATTERNS.map(({ label }) => label),
    );

    for (const requiredLabel of REQUIRED_FORBIDDEN_RUNTIME_HARDENING_PATTERN_LABELS) {
      expect(
        forbiddenPatternLabels.has(requiredLabel),
        `Expected forbidden runtime hardening pattern table to include: ${requiredLabel}`,
      ).to.equal(true);
    }
  });

  it('keeps required forbidden runtime hardening labels normalized and deeply frozen', () => {
    expect(
      Object.isFrozen(REQUIRED_FORBIDDEN_RUNTIME_HARDENING_PATTERN_LABELS),
    ).to.equal(true);
    expect(
      REQUIRED_FORBIDDEN_RUNTIME_HARDENING_PATTERN_LABELS.length,
    ).to.be.greaterThan(0);

    const baselineLabels = [
      ...REQUIRED_FORBIDDEN_RUNTIME_HARDENING_PATTERN_LABELS,
    ];
    const seenLabels = new Set<string>();
    for (const requiredLabel of REQUIRED_FORBIDDEN_RUNTIME_HARDENING_PATTERN_LABELS) {
      expect(requiredLabel.trim().length).to.be.greaterThan(0);
      expect(
        seenLabels.has(requiredLabel),
        `Expected required forbidden labels to be unique: ${requiredLabel}`,
      ).to.equal(false);
      seenLabels.add(requiredLabel);
    }

    expect(() => {
      (
        REQUIRED_FORBIDDEN_RUNTIME_HARDENING_PATTERN_LABELS as unknown as string[]
      ).push('injected required label');
    }).to.throw(TypeError);
    expect(() => {
      (
        REQUIRED_FORBIDDEN_RUNTIME_HARDENING_PATTERN_LABELS as unknown as string[]
      )[0] = 'mutated required label';
    }).to.throw(TypeError);

    expect(REQUIRED_FORBIDDEN_RUNTIME_HARDENING_PATTERN_LABELS).to.deep.equal(
      baselineLabels,
    );
  });

  it('keeps forbidden runtime hardening patterns deeply frozen', () => {
    expect(Object.isFrozen(FORBIDDEN_RUNTIME_HARDENING_PATTERNS)).to.equal(
      true,
    );
    for (const patternEntry of FORBIDDEN_RUNTIME_HARDENING_PATTERNS) {
      expect(Object.isFrozen(patternEntry)).to.equal(true);
    }

    const baselinePatternSignatures = FORBIDDEN_RUNTIME_HARDENING_PATTERNS.map(
      ({ label, pattern }) => `${label}::/${pattern.source}/${pattern.flags}`,
    );

    expect(() => {
      (FORBIDDEN_RUNTIME_HARDENING_PATTERNS as unknown as Array<unknown>).push({
        label: 'injected pattern',
        pattern: /injected/,
      });
    }).to.throw(TypeError);

    expect(() => {
      (
        FORBIDDEN_RUNTIME_HARDENING_PATTERNS as unknown as Array<{
          label: string;
          pattern: RegExp;
        }>
      )[0] = { label: 'replaced pattern', pattern: /replaced/ };
    }).to.throw(TypeError);

    expect(() => {
      (
        FORBIDDEN_RUNTIME_HARDENING_PATTERNS as unknown as Array<{
          label: string;
          pattern: RegExp;
        }>
      )[0].label = 'mutated label';
    }).to.throw(TypeError);

    const postMutationPatternSignatures =
      FORBIDDEN_RUNTIME_HARDENING_PATTERNS.map(
        ({ label, pattern }) => `${label}::/${pattern.source}/${pattern.flags}`,
      );
    expect(postMutationPatternSignatures).to.deep.equal(
      baselinePatternSignatures,
    );
  });

  it('keeps method-call forbidden pattern labels aligned with regexes', () => {
    const methodCallLabelPattern = /^\.([A-Za-z0-9_]+) method call$/;

    for (const { label, pattern } of FORBIDDEN_RUNTIME_HARDENING_PATTERNS) {
      const methodLabelMatch = methodCallLabelPattern.exec(label);
      if (!methodLabelMatch) {
        continue;
      }

      const [, methodName] = methodLabelMatch;
      expect(
        pattern.test(`value.${methodName}(`),
        `Expected ${label} pattern to match direct method-call snippet`,
      ).to.equal(true);
      expect(
        pattern.test(`value.${methodName}Suffix(`),
        `Expected ${label} pattern to avoid suffix-prefixed method names`,
      ).to.equal(false);
    }
  });

  it('keeps static-call forbidden pattern labels aligned with regexes', () => {
    const staticCallLabelPattern = /^([A-Za-z0-9_.]+) call$/;

    for (const { label, pattern } of FORBIDDEN_RUNTIME_HARDENING_PATTERNS) {
      if (label.endsWith('method call')) {
        continue;
      }
      const staticCallLabelMatch = staticCallLabelPattern.exec(label);
      if (!staticCallLabelMatch) {
        continue;
      }

      const [, staticCallee] = staticCallLabelMatch;
      expect(
        pattern.test(`${staticCallee}(`),
        `Expected ${label} pattern to match direct static-call snippet`,
      ).to.equal(true);
      expect(
        pattern.test(`${staticCallee}Suffix(`),
        `Expected ${label} pattern to avoid suffix-prefixed static names`,
      ).to.equal(false);
      expect(
        pattern.test(`prefix${staticCallee}(`),
        `Expected ${label} pattern to avoid prefixed identifier static names`,
      ).to.equal(false);
    }
  });

  it('keeps static-access forbidden pattern labels aligned with regexes', () => {
    const staticAccessLabelPattern = /^([A-Za-z0-9_.]+) access$/;

    for (const { label, pattern } of FORBIDDEN_RUNTIME_HARDENING_PATTERNS) {
      const staticAccessLabelMatch = staticAccessLabelPattern.exec(label);
      if (!staticAccessLabelMatch) {
        continue;
      }

      const [, staticAccessPath] = staticAccessLabelMatch;
      expect(
        pattern.test(staticAccessPath),
        `Expected ${label} pattern to match direct static-access snippet`,
      ).to.equal(true);
      expect(
        pattern.test(`${staticAccessPath}Suffix`),
        `Expected ${label} pattern to avoid suffix-prefixed static-access names`,
      ).to.equal(false);
      expect(
        pattern.test(`prefix${staticAccessPath}`),
        `Expected ${label} pattern to avoid prefixed static-access names`,
      ).to.equal(false);
    }
  });

  it('keeps recursive sdk squads discovery helpers isolated from caller mutation', () => {
    assertPathSnapshotIsolation(
      listSdkSquadsTestFilePaths,
      'sdk squads top-level test-path discovery',
    );
    assertPathSnapshotIsolation(
      listSdkSquadsNonTestSourceFilePaths,
      'sdk squads top-level non-test source discovery',
    );
    assertPathSnapshotIsolation(
      () => listSdkSquadsTestFilePathsRecursively(SDK_SQUADS_SOURCE_DIR),
      'sdk squads recursive test-path discovery',
    );
    assertPathSnapshotIsolation(
      () =>
        listSdkSquadsNonTestSourceFilePathsRecursively(SDK_SQUADS_SOURCE_DIR),
      'sdk squads recursive non-test source discovery',
    );
    assertPathSnapshotIsolation(
      () => listSdkSquadsTypeScriptPathsRecursively(SDK_SQUADS_SOURCE_DIR),
      'sdk squads recursive TypeScript discovery',
    );
    assertPathSnapshotIsolation(
      listSquadsBarrelExportedSourcePaths,
      'sdk squads barrel-exported source discovery',
    );
  });
});
