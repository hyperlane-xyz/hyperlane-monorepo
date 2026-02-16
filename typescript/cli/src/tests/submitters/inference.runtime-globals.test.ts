import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

import { expect } from 'chai';
import sinon from 'sinon';

import {
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
});
