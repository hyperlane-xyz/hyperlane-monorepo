import { fileURLToPath } from 'url';
import path from 'path';

import { expect } from 'chai';

import {
  SUPPORTED_RUNTIME_PRIMITIVE_VALUE_TYPES,
  getKnownObjectLikeProbeLabelsFromOtherTests,
  getProbeLabelFromInferenceTestTitle,
  getRuntimeFunctionValuesByLabel,
  getRuntimeObjectValuesByLabel,
  getRuntimePrimitiveValuesByLabel,
  isSupportedRuntimePrimitiveValueType,
} from './inference.runtime-globals.js';

const HELPER_ONLY_OBJECT_LIKE_LABEL = '__runtime_helper_only-object';

describe('runtime global probe helpers', () => {
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

  it('exposes runtime function/object/primitive value maps with labeled keys', () => {
    const functionMap = getRuntimeFunctionValuesByLabel();
    const objectMap = getRuntimeObjectValuesByLabel();
    const primitiveMap = getRuntimePrimitiveValuesByLabel();

    expect(functionMap.size).to.be.greaterThan(0);
    expect(objectMap.size).to.be.greaterThan(0);
    expect(primitiveMap.size).to.be.greaterThan(0);

    for (const [label, value] of functionMap) {
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
  });
});
