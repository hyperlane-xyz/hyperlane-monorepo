import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

import { expect } from 'chai';
import sinon from 'sinon';

import {
  getCachedRuntimeFunctionValuesByLabel,
  getCachedRuntimeIntlFunctionValuesByLabel,
  getCachedRuntimeObjectValuesByLabel,
  getCachedRuntimePrimitiveValuesByLabel,
  SUPPORTED_RUNTIME_PRIMITIVE_VALUE_TYPES,
  getCleanRuntimeProbeLabels,
  getFallbackPrimitiveProbeValueFromLabel,
  getKnownObjectLikeProbeLabelsFromOtherTests,
  getProbeLabelFromInferenceTestTitle,
  getRequiredRuntimeFunctionValueByLabel,
  getRuntimeFunctionValuesByLabel,
  getRuntimeIntlFunctionValuesByLabel,
  getRuntimeObjectValuesByLabel,
  getRuntimePrimitiveValuesByLabel,
  isSupportedRuntimePrimitiveValueType,
  resolveRuntimeIntlFunctionProbeCases,
  resolveRuntimeFunctionProbeCases,
} from './inference.runtime-globals.js';

const HELPER_ONLY_OBJECT_LIKE_LABEL = '__runtime_helper_only-object';

describe('runtime global probe helpers', () => {
  it('returns defensive copies for clean runtime label snapshots', () => {
    const first = getCleanRuntimeProbeLabels();
    first.functionLabels.push('__mutated_function_label__');
    first.objectLabels.push('__mutated_object_label__');
    first.primitiveLabels.push('__mutated_primitive_label__');

    const second = getCleanRuntimeProbeLabels();
    expect(
      second.functionLabels.includes('__mutated_function_label__'),
    ).to.equal(false);
    expect(second.objectLabels.includes('__mutated_object_label__')).to.equal(
      false,
    );
    expect(
      second.primitiveLabels.includes('__mutated_primitive_label__'),
    ).to.equal(false);
  });

  it('returns object-like labels from neighboring inference test files', () => {
    const labels = getKnownObjectLikeProbeLabelsFromOtherTests(
      fileURLToPath(import.meta.url),
    );

    expect(labels.size).to.be.greaterThan(0);
    expect(labels.has('array-constructor-object')).to.equal(true);
    expect(labels.has('undefined-undefined-primitive')).to.equal(false);
    expect(labels.has(HELPER_ONLY_OBJECT_LIKE_LABEL)).to.equal(false);
  });

  it('returns defensive copies for cached known-label sets', () => {
    const filePath = fileURLToPath(import.meta.url);
    const first = getKnownObjectLikeProbeLabelsFromOtherTests(filePath);
    first.add('__mutated-label__');

    const second = getKnownObjectLikeProbeLabelsFromOtherTests(filePath);
    expect(second.has('__mutated-label__')).to.equal(false);
  });

  it('normalizes file paths for known-label cache lookups', () => {
    const absoluteFilePath = fileURLToPath(import.meta.url);
    const relativeFromCwd = path.relative(process.cwd(), absoluteFilePath);

    const fromAbsolute =
      getKnownObjectLikeProbeLabelsFromOtherTests(absoluteFilePath);
    const fromRelative =
      getKnownObjectLikeProbeLabelsFromOtherTests(relativeFromCwd);

    expect([...fromRelative].sort()).to.deep.equal([...fromAbsolute].sort());
  });

  it('returns an empty label set when test directory is unreadable', () => {
    const unreadablePath = path.join(
      process.cwd(),
      '__nonexistent_runtime_probe_tests__',
      'inference.missing.test.ts',
    );
    const labels = getKnownObjectLikeProbeLabelsFromOtherTests(unreadablePath);
    expect(labels.size).to.equal(0);
  });

  it('does not cache empty labels on transient directory read failures', () => {
    const baseDir = path.dirname(fileURLToPath(import.meta.url));
    const syntheticFilePath = path.join(
      baseDir,
      'inference.synthetic-runtime-helper.test.ts',
    );
    let failedOnce = false;
    const readdirStub = sinon.stub(fs, 'readdirSync').callsFake(((
      targetPath: string,
      ...args: unknown[]
    ) => {
      if (!failedOnce && path.resolve(targetPath) === path.resolve(baseDir)) {
        failedOnce = true;
        throw new Error('transient read failure');
      }
      return (readdirStub.wrappedMethod as any)(targetPath, ...args);
    }) as typeof fs.readdirSync);

    try {
      const first =
        getKnownObjectLikeProbeLabelsFromOtherTests(syntheticFilePath);
      expect(first.size).to.equal(0);

      const second =
        getKnownObjectLikeProbeLabelsFromOtherTests(syntheticFilePath);
      expect(second.size).to.be.greaterThan(0);
    } finally {
      readdirStub.restore();
    }
  });

  it('does not cache partial labels on transient file read failures', () => {
    const baseDir = path.dirname(fileURLToPath(import.meta.url));
    const syntheticFilePath = path.join(
      baseDir,
      'inference.synthetic-runtime-helper-file-read.test.ts',
    );
    let failedOnce = false;
    const readFileStub = sinon.stub(fs, 'readFileSync').callsFake(((
      targetPath: string,
      ...args: unknown[]
    ) => {
      if (
        !failedOnce &&
        path.basename(targetPath) === 'inference.function-edge-cases.test.ts'
      ) {
        failedOnce = true;
        throw new Error('transient file read failure');
      }
      return (readFileStub.wrappedMethod as any)(targetPath, ...args);
    }) as typeof fs.readFileSync);

    try {
      const first =
        getKnownObjectLikeProbeLabelsFromOtherTests(syntheticFilePath);
      expect(first.has('arrow-function-object')).to.equal(false);

      const second =
        getKnownObjectLikeProbeLabelsFromOtherTests(syntheticFilePath);
      expect(second.has('arrow-function-object')).to.equal(true);
    } finally {
      readFileStub.restore();
    }
  });

  it('exposes runtime function/object/primitive value maps with labeled keys', () => {
    const functionMap = getRuntimeFunctionValuesByLabel();
    const intlFunctionMap = getRuntimeIntlFunctionValuesByLabel();
    const objectMap = getRuntimeObjectValuesByLabel();
    const primitiveMap = getRuntimePrimitiveValuesByLabel();

    expect(functionMap.size).to.be.greaterThan(0);
    expect(intlFunctionMap.size).to.be.greaterThan(0);
    expect(intlFunctionMap.has('intl-collator-constructor-object')).to.equal(
      true,
    );
    expect(objectMap.size).to.be.greaterThan(0);
    expect(primitiveMap.size).to.be.greaterThan(0);

    for (const [label, value] of functionMap) {
      expect(label.endsWith('-constructor-object')).to.equal(true);
      expect(typeof value).to.equal('function');
    }
    for (const [label, value] of intlFunctionMap) {
      expect(label.startsWith('intl-')).to.equal(true);
      expect(label.endsWith('-constructor-object')).to.equal(true);
      expect(typeof value).to.equal('function');
    }
    for (const [label, value] of objectMap) {
      expect(label.endsWith('-object')).to.equal(true);
      expect(value !== null && typeof value === 'object').to.equal(true);
    }
    for (const [label, value] of primitiveMap) {
      expect(label.endsWith('-primitive')).to.equal(true);
      expect(isSupportedRuntimePrimitiveValueType(typeof value)).to.equal(true);
    }
  });

  it('returns defensive copies for cached runtime map helpers', () => {
    const firstFunctionMap = getCachedRuntimeFunctionValuesByLabel();
    firstFunctionMap.delete('array-constructor-object');
    const secondFunctionMap = getCachedRuntimeFunctionValuesByLabel();
    expect(secondFunctionMap.has('array-constructor-object')).to.equal(true);

    const firstObjectMap = getCachedRuntimeObjectValuesByLabel();
    firstObjectMap.delete('math-object');
    const secondObjectMap = getCachedRuntimeObjectValuesByLabel();
    expect(secondObjectMap.has('math-object')).to.equal(true);

    const firstIntlFunctionMap = getCachedRuntimeIntlFunctionValuesByLabel();
    firstIntlFunctionMap.delete('intl-collator-constructor-object');
    const secondIntlFunctionMap = getCachedRuntimeIntlFunctionValuesByLabel();
    expect(
      secondIntlFunctionMap.has('intl-collator-constructor-object'),
    ).to.equal(true);

    const firstPrimitiveMap = getCachedRuntimePrimitiveValuesByLabel();
    firstPrimitiveMap.delete('nan-number-primitive');
    const secondPrimitiveMap = getCachedRuntimePrimitiveValuesByLabel();
    expect(secondPrimitiveMap.has('nan-number-primitive')).to.equal(true);
  });

  it('accepts only supported primitive type names', () => {
    for (const valueType of SUPPORTED_RUNTIME_PRIMITIVE_VALUE_TYPES) {
      expect(isSupportedRuntimePrimitiveValueType(valueType)).to.equal(true);
    }
    expect(isSupportedRuntimePrimitiveValueType('object')).to.equal(false);
    expect(isSupportedRuntimePrimitiveValueType('function')).to.equal(false);
  });

  it('skips throwing global getters when building runtime maps', () => {
    const throwingGlobalName = '__throwing_runtime_probe_getter__';
    Object.defineProperty(globalThis, throwingGlobalName, {
      configurable: true,
      get: () => {
        throw new Error('expected test getter throw');
      },
    });

    try {
      expect(() => getRuntimeFunctionValuesByLabel()).to.not.throw();
      expect(() => getRuntimeObjectValuesByLabel()).to.not.throw();
      expect(() => getRuntimePrimitiveValuesByLabel()).to.not.throw();

      const functionMap = getRuntimeFunctionValuesByLabel();
      const objectMap = getRuntimeObjectValuesByLabel();
      const primitiveMap = getRuntimePrimitiveValuesByLabel();
      const lowered = throwingGlobalName.toLowerCase();
      expect(functionMap.has(`${lowered}-constructor-object`)).to.equal(false);
      expect(objectMap.has(`${lowered}-object`)).to.equal(false);
      expect(primitiveMap.has(`${lowered}-string-primitive`)).to.equal(false);
      expect(primitiveMap.has(`${lowered}-symbol-primitive`)).to.equal(false);
    } finally {
      Reflect.deleteProperty(globalThis, throwingGlobalName);
    }
  });

  it('skips throwing Intl getters when building intl runtime map', () => {
    const throwingIntlProperty = '__throwing_intl_runtime_probe_getter__';
    Object.defineProperty(Intl, throwingIntlProperty, {
      configurable: true,
      get: () => {
        throw new Error('expected intl getter throw');
      },
    });

    try {
      expect(() => getRuntimeIntlFunctionValuesByLabel()).to.not.throw();
      const intlFunctionMap = getRuntimeIntlFunctionValuesByLabel();
      expect(
        intlFunctionMap.has(
          `intl-${throwingIntlProperty.toLowerCase()}-constructor-object`,
        ),
      ).to.equal(false);
    } finally {
      Reflect.deleteProperty(Intl, throwingIntlProperty);
    }
  });

  it('extracts probe labels from generated test titles', () => {
    expect(
      getProbeLabelFromInferenceTestTitle(
        'caches array-constructor-object origin signer probes across timelock ICA inferences',
      ),
    ).to.equal('array-constructor-object');
    expect(
      getProbeLabelFromInferenceTestTitle(
        'caches async __filename-string-primitive origin signer probes across timelock ICA inferences',
      ),
    ).to.equal('__filename-string-primitive');
    expect(
      getProbeLabelFromInferenceTestTitle(
        `caches event-derived async ${HELPER_ONLY_OBJECT_LIKE_LABEL} origin signer probes across timelock ICA inferences`,
      ),
    ).to.equal(HELPER_ONLY_OBJECT_LIKE_LABEL);
    expect(
      getProbeLabelFromInferenceTestTitle(
        'some unrelated test title that should not match',
      ),
    ).to.equal(null);
    expect(
      getProbeLabelFromInferenceTestTitle(
        '  caches array-constructor-object origin signer probes across timelock ICA inferences  ',
      ),
    ).to.equal('array-constructor-object');
    expect(
      getProbeLabelFromInferenceTestTitle(
        'prefix caches array-constructor-object origin signer probes across timelock ICA inferences',
      ),
    ).to.equal(null);
    expect(
      getProbeLabelFromInferenceTestTitle(
        'caches array-constructor-object origin signer probes across timelock ICA inferences suffix',
      ),
    ).to.equal(null);
  });

  it('builds primitive fallback values from probe labels', () => {
    expect(
      getFallbackPrimitiveProbeValueFromLabel('undefined-undefined-primitive'),
    ).to.equal(undefined);
    expect(
      getFallbackPrimitiveProbeValueFromLabel('infinity-number-primitive'),
    ).to.equal(Number.POSITIVE_INFINITY);
    expect(
      Number.isNaN(
        getFallbackPrimitiveProbeValueFromLabel('nan-number-primitive'),
      ),
    ).to.equal(true);
    expect(
      getFallbackPrimitiveProbeValueFromLabel('flag-boolean-primitive'),
    ).to.equal(false);
    expect(
      getFallbackPrimitiveProbeValueFromLabel('amount-bigint-primitive'),
    ).to.equal(0n);
    expect(
      String(getFallbackPrimitiveProbeValueFromLabel('probe-symbol-primitive')),
    ).to.equal('Symbol(probe-symbol-primitive)');
    expect(
      getFallbackPrimitiveProbeValueFromLabel('name-string-primitive'),
    ).to.equal('name-string-primitive');
    expect(getFallbackPrimitiveProbeValueFromLabel('unknown-label')).to.equal(
      undefined,
    );
  });

  it('resolves runtime function probe cases by available labels', () => {
    const resolvedWithoutMap = resolveRuntimeFunctionProbeCases([
      {
        label: 'array-constructor-object',
        directGetLogsCallCount: 4,
      },
    ]);
    expect(resolvedWithoutMap).to.have.length(1);
    expect(resolvedWithoutMap[0].constructorValue).to.equal(Array);

    const resolved = resolveRuntimeFunctionProbeCases(
      [
        {
          label: 'array-constructor-object',
          directGetLogsCallCount: 4,
        },
        {
          label: 'missing-constructor-object',
          directGetLogsCallCount: 7,
        },
      ],
      getRuntimeFunctionValuesByLabel(),
    );

    expect(resolved).to.have.length(1);
    expect(resolved[0].label).to.equal('array-constructor-object');
    expect(resolved[0].directGetLogsCallCount).to.equal(4);
    expect(typeof resolved[0].constructorValue).to.equal('function');
  });

  it('resolves runtime Intl function probe cases by available labels', () => {
    const resolvedWithoutMap = resolveRuntimeIntlFunctionProbeCases([
      {
        label: 'intl-collator-constructor-object',
        directGetLogsCallCount: 5,
      },
    ]);
    expect(resolvedWithoutMap).to.have.length(1);
    expect(resolvedWithoutMap[0].constructorValue).to.equal(Intl.Collator);

    const resolved = resolveRuntimeIntlFunctionProbeCases(
      [
        {
          label: 'intl-collator-constructor-object',
          directGetLogsCallCount: 5,
        },
        {
          label: '__missing-intl-constructor-object',
          directGetLogsCallCount: 7,
        },
      ],
      getRuntimeIntlFunctionValuesByLabel(),
    );

    expect(resolved).to.have.length(1);
    expect(resolved[0].label).to.equal('intl-collator-constructor-object');
    expect(resolved[0].directGetLogsCallCount).to.equal(5);
    expect(typeof resolved[0].constructorValue).to.equal('function');
  });

  it('returns required runtime function probe values by label', () => {
    const runtimeFunctionMap = getRuntimeFunctionValuesByLabel();
    expect(
      getRequiredRuntimeFunctionValueByLabel('array-constructor-object'),
    ).to.equal(Array);
    expect(
      getRequiredRuntimeFunctionValueByLabel(
        'array-constructor-object',
        runtimeFunctionMap,
      ),
    ).to.equal(Array);
    expect(() =>
      getRequiredRuntimeFunctionValueByLabel(
        '__missing-constructor-object',
        runtimeFunctionMap,
      ),
    ).to.throw(
      'Missing runtime function probe value for label "__missing-constructor-object"',
    );
  });

  it('keeps cached runtime function probe snapshots stable', () => {
    // Prime the cached no-map lookup path first.
    expect(
      getRequiredRuntimeFunctionValueByLabel('array-constructor-object'),
    ).to.equal(Array);

    const injectedGlobalName = '__InjectedRuntimeProbeConstructor__';
    const injectedLabel = `${injectedGlobalName.toLowerCase()}-constructor-object`;
    const injectedConstructor = function InjectedRuntimeProbeConstructor() {
      return undefined;
    };
    (globalThis as any)[injectedGlobalName] = injectedConstructor;

    try {
      // Fresh explicit maps can observe newly injected globals.
      const freshRuntimeFunctionMap = getRuntimeFunctionValuesByLabel();
      expect(freshRuntimeFunctionMap.get(injectedLabel)).to.equal(
        injectedConstructor,
      );

      // Cached no-map helpers intentionally keep a stable snapshot.
      expect(() =>
        getRequiredRuntimeFunctionValueByLabel(injectedLabel),
      ).to.throw(
        `Missing runtime function probe value for label "${injectedLabel}"`,
      );
      const defaultResolvedCases = resolveRuntimeFunctionProbeCases([
        { label: injectedLabel, directGetLogsCallCount: 1 },
      ]);
      expect(defaultResolvedCases).to.have.length(0);

      // Explicit-map resolver remains dynamic.
      const explicitResolvedCases = resolveRuntimeFunctionProbeCases(
        [{ label: injectedLabel, directGetLogsCallCount: 1 }],
        freshRuntimeFunctionMap,
      );
      expect(explicitResolvedCases).to.have.length(1);
      expect(explicitResolvedCases[0].constructorValue).to.equal(
        injectedConstructor,
      );
    } finally {
      Reflect.deleteProperty(globalThis, injectedGlobalName);
    }
  });

  it('keeps cached runtime object/primitive probe snapshots stable', () => {
    // Prime cached no-arg helper snapshots first.
    expect(getCachedRuntimeObjectValuesByLabel().has('math-object')).to.equal(
      true,
    );
    expect(
      getCachedRuntimePrimitiveValuesByLabel().has('nan-number-primitive'),
    ).to.equal(true);

    const injectedObjectGlobalName = '__InjectedRuntimeProbeObject__';
    const injectedObjectLabel = `${injectedObjectGlobalName.toLowerCase()}-object`;
    const injectedObjectValue = {
      injected: true,
    };

    const injectedPrimitiveGlobalName = '__InjectedRuntimeProbePrimitive__';
    const injectedPrimitiveLabel = `${injectedPrimitiveGlobalName.toLowerCase()}-string-primitive`;
    const injectedPrimitiveValue = 'injected-runtime-primitive';

    (globalThis as any)[injectedObjectGlobalName] = injectedObjectValue;
    (globalThis as any)[injectedPrimitiveGlobalName] = injectedPrimitiveValue;

    try {
      // Fresh explicit maps can observe newly injected globals.
      const freshRuntimeObjectMap = getRuntimeObjectValuesByLabel();
      expect(freshRuntimeObjectMap.get(injectedObjectLabel)).to.equal(
        injectedObjectValue,
      );
      const freshRuntimePrimitiveMap = getRuntimePrimitiveValuesByLabel();
      expect(freshRuntimePrimitiveMap.get(injectedPrimitiveLabel)).to.equal(
        injectedPrimitiveValue,
      );

      // Cached no-map helpers intentionally keep a stable snapshot.
      expect(
        getCachedRuntimeObjectValuesByLabel().has(injectedObjectLabel),
      ).to.equal(false);
      expect(
        getCachedRuntimePrimitiveValuesByLabel().has(injectedPrimitiveLabel),
      ).to.equal(false);
    } finally {
      Reflect.deleteProperty(globalThis, injectedObjectGlobalName);
      Reflect.deleteProperty(globalThis, injectedPrimitiveGlobalName);
    }
  });

  it('keeps cached runtime Intl probe snapshots stable', () => {
    // Prime cached no-map Intl helper snapshot first.
    expect(
      getCachedRuntimeIntlFunctionValuesByLabel().has(
        'intl-collator-constructor-object',
      ),
    ).to.equal(true);

    const injectedIntlProperty = '__InjectedIntlRuntimeProbeConstructor__';
    const injectedIntlLabel = `intl-${injectedIntlProperty.toLowerCase()}-constructor-object`;
    const injectedIntlConstructor =
      function InjectedIntlRuntimeProbeConstructor() {
        return undefined;
      };
    Object.defineProperty(Intl, injectedIntlProperty, {
      configurable: true,
      writable: true,
      value: injectedIntlConstructor,
    });

    try {
      // Fresh explicit map can observe newly injected Intl function properties.
      const freshRuntimeIntlFunctionMap = getRuntimeIntlFunctionValuesByLabel();
      expect(freshRuntimeIntlFunctionMap.get(injectedIntlLabel)).to.equal(
        injectedIntlConstructor,
      );

      // Cached no-map helpers/resolvers intentionally keep a stable snapshot.
      expect(
        getCachedRuntimeIntlFunctionValuesByLabel().has(injectedIntlLabel),
      ).to.equal(false);
      const defaultResolvedCases = resolveRuntimeIntlFunctionProbeCases([
        { label: injectedIntlLabel, directGetLogsCallCount: 1 },
      ]);
      expect(defaultResolvedCases).to.have.length(0);

      // Explicit-map resolver remains dynamic.
      const explicitResolvedCases = resolveRuntimeIntlFunctionProbeCases(
        [{ label: injectedIntlLabel, directGetLogsCallCount: 1 }],
        freshRuntimeIntlFunctionMap,
      );
      expect(explicitResolvedCases).to.have.length(1);
      expect(explicitResolvedCases[0].constructorValue).to.equal(
        injectedIntlConstructor,
      );
    } finally {
      Reflect.deleteProperty(Intl, injectedIntlProperty);
    }
  });

  it('keeps constructor probe case tables free of hardcoded globals', () => {
    const constructorProbeFilePattern =
      /^inference\..*constructor(?:s)?\.test\.ts$/;
    const hardcodedConstructorAssignmentPattern =
      /constructorValue:\s*[A-Z][A-Za-z0-9_.]*(?=,\s*directGetLogsCallCount)/g;
    const submitterTestDir = path.dirname(fileURLToPath(import.meta.url));
    const constructorProbeFiles = fs
      .readdirSync(submitterTestDir)
      .filter((fileName) => constructorProbeFilePattern.test(fileName));

    const hardcodedAssignments = constructorProbeFiles.flatMap((fileName) => {
      const filePath = path.join(submitterTestDir, fileName);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const matches = [
        ...fileContent.matchAll(hardcodedConstructorAssignmentPattern),
      ];
      return matches.map((match) => `${fileName}: ${match[0]}`);
    });

    expect(hardcodedAssignments).to.deep.equal([]);
  });

  it('keeps constructor probe tryGetSigner returns free of direct globals', () => {
    const constructorProbeFilePattern =
      /^inference\..*constructor(?:s)?\.test\.ts$/;
    const hardcodedReturnPattern =
      /\breturn\s+(?:Array|ArrayBuffer|SharedArrayBuffer|DataView|BigInt64Array|BigUint64Array|Uint8ClampedArray|Float64Array|Float32Array|Int32Array|Int16Array|Int8Array|Uint32Array|Uint16Array|Uint8Array|Function|Object|Error|AggregateError|EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError|RegExp|Number|Boolean|String|BigInt|Symbol|Map|Set|WeakMap|WeakSet|Promise|Date)\s*;/g;
    const submitterTestDir = path.dirname(fileURLToPath(import.meta.url));
    const constructorProbeFiles = fs
      .readdirSync(submitterTestDir)
      .filter((fileName) => constructorProbeFilePattern.test(fileName));

    const hardcodedReturns = constructorProbeFiles.flatMap((fileName) => {
      const filePath = path.join(submitterTestDir, fileName);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const matches = [...fileContent.matchAll(hardcodedReturnPattern)];
      return matches.map((match) => `${fileName}: ${match[0]}`);
    });

    expect(hardcodedReturns).to.deep.equal([]);
  });

  it('enforces constructor probe files to use shared runtime helpers', () => {
    const constructorProbeFilePattern =
      /^inference\..*constructor(?:s)?\.test\.ts$/;
    const submitterTestDir = path.dirname(fileURLToPath(import.meta.url));
    const constructorProbeFiles = fs
      .readdirSync(submitterTestDir)
      .filter((fileName) => constructorProbeFilePattern.test(fileName));

    const filesMissingSharedHelper = constructorProbeFiles.filter(
      (fileName) => {
        const fileContent = fs.readFileSync(
          path.join(submitterTestDir, fileName),
          'utf8',
        );
        const usesRequiredSingleProbeHelper = fileContent.includes(
          'getRequiredRuntimeFunctionValueByLabel',
        );
        const usesGroupedProbeResolver = fileContent.includes(
          'resolveRuntimeFunctionProbeCases',
        );
        const usesGroupedIntlProbeResolver = fileContent.includes(
          'resolveRuntimeIntlFunctionProbeCases',
        );
        return (
          !usesRequiredSingleProbeHelper &&
          !usesGroupedProbeResolver &&
          !usesGroupedIntlProbeResolver
        );
      },
    );

    expect(filesMissingSharedHelper).to.deep.equal([]);
  });

  it('keeps constructor probe files on cached helper entrypoints', () => {
    const constructorProbeFilePattern =
      /^inference\..*constructor(?:s)?\.test\.ts$/;
    const submitterTestDir = path.dirname(fileURLToPath(import.meta.url));
    const constructorProbeFiles = fs
      .readdirSync(submitterTestDir)
      .filter((fileName) => constructorProbeFilePattern.test(fileName));

    const filesUsingRawRuntimeMaps = constructorProbeFiles.filter(
      (fileName) => {
        const fileContent = fs.readFileSync(
          path.join(submitterTestDir, fileName),
          'utf8',
        );
        return (
          fileContent.includes('getRuntimeFunctionValuesByLabel(') ||
          fileContent.includes('getRuntimeIntlFunctionValuesByLabel(')
        );
      },
    );

    expect(filesUsingRawRuntimeMaps).to.deep.equal([]);
  });

  it('keeps global probe files on cached helper entrypoints', () => {
    const globalProbeFiles = [
      'inference.global-function-probes.test.ts',
      'inference.global-object-probes.test.ts',
      'inference.primitive-global-probes.test.ts',
    ];
    const submitterTestDir = path.dirname(fileURLToPath(import.meta.url));

    const filesUsingRawRuntimeMaps = globalProbeFiles.filter((fileName) => {
      const fileContent = fs.readFileSync(
        path.join(submitterTestDir, fileName),
        'utf8',
      );
      return (
        fileContent.includes('getRuntimeFunctionValuesByLabel(') ||
        fileContent.includes('getRuntimeObjectValuesByLabel(') ||
        fileContent.includes('getRuntimePrimitiveValuesByLabel(')
      );
    });

    expect(filesUsingRawRuntimeMaps).to.deep.equal([]);
  });

  it('enforces cached helper usage in global probe files', () => {
    const submitterTestDir = path.dirname(fileURLToPath(import.meta.url));
    const requiredCachedHelperByFile = new Map<string, string>([
      [
        'inference.global-function-probes.test.ts',
        'getCachedRuntimeFunctionValuesByLabel',
      ],
      [
        'inference.global-object-probes.test.ts',
        'getCachedRuntimeObjectValuesByLabel',
      ],
      [
        'inference.primitive-global-probes.test.ts',
        'getCachedRuntimePrimitiveValuesByLabel',
      ],
    ]);

    const filesMissingCachedHelpers = [...requiredCachedHelperByFile.entries()]
      .filter(([fileName, helperName]) => {
        const fileContent = fs.readFileSync(
          path.join(submitterTestDir, fileName),
          'utf8',
        );
        return !fileContent.includes(helperName);
      })
      .map(([fileName]) => fileName);

    expect(filesMissingCachedHelpers).to.deep.equal([]);
  });
});
