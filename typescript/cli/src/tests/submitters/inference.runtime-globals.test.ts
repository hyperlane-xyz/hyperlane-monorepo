import { fileURLToPath } from 'url';

import { expect } from 'chai';

import {
  SUPPORTED_RUNTIME_PRIMITIVE_VALUE_TYPES,
  getKnownObjectLikeProbeLabelsFromOtherTests,
  getRuntimeFunctionValuesByLabel,
  getRuntimeObjectValuesByLabel,
  getRuntimePrimitiveValuesByLabel,
  isSupportedRuntimePrimitiveValueType,
} from './inference.runtime-globals.js';

describe('runtime global probe helpers', () => {
  it('returns object-like labels from neighboring inference test files', () => {
    const labels = getKnownObjectLikeProbeLabelsFromOtherTests(
      fileURLToPath(import.meta.url),
    );

    expect(labels.size).to.be.greaterThan(0);
    expect(labels.has('array-constructor-object')).to.equal(true);
    expect(labels.has('undefined-undefined-primitive')).to.equal(false);
  });

  it('returns defensive copies for cached known-label sets', () => {
    const filePath = fileURLToPath(import.meta.url);
    const first = getKnownObjectLikeProbeLabelsFromOtherTests(filePath);
    first.add('__mutated-label__');

    const second = getKnownObjectLikeProbeLabelsFromOtherTests(filePath);
    expect(second.has('__mutated-label__')).to.equal(false);
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
});
