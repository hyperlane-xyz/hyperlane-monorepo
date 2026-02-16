import { expect } from 'chai';

import {
  getCleanRuntimeProbeLabels,
  getProbeLabelFromInferenceTestTitle,
} from './inference.runtime-globals.js';

describe('resolveSubmitterBatchesForTransactions global runtime probe coverage', () => {
  const getCoveredLabelsFromGeneratedTests = (currentTest: any) => {
    const coveredLabels = new Set<string>();
    let rootSuite = currentTest.parent;
    while (rootSuite?.parent) rootSuite = rootSuite.parent;

    const suiteStack = [rootSuite];
    while (suiteStack.length) {
      const suite = suiteStack.pop();
      for (const test of suite?.tests ?? []) {
        const title = String(test.title ?? '');
        const label = getProbeLabelFromInferenceTestTitle(title);
        if (label) coveredLabels.add(label);
      }
      suiteStack.push(...(suite?.suites ?? []));
    }

    return coveredLabels;
  };

  const cleanRuntimeLabels = getCleanRuntimeProbeLabels();

  it('covers every runtime function-valued global with constructor probe labels', function () {
    const coveredLabels = getCoveredLabelsFromGeneratedTests(this.test);
    const missing = cleanRuntimeLabels.functionLabels.filter(
      (label) => !coveredLabels.has(label),
    );
    expect(missing).to.deep.equal([]);
  });

  it('covers every runtime object-valued global with object probe labels', function () {
    const coveredLabels = getCoveredLabelsFromGeneratedTests(this.test);
    const missing = cleanRuntimeLabels.objectLabels.filter(
      (label) => !coveredLabels.has(label),
    );
    expect(missing).to.deep.equal([]);
  });

  it('covers every runtime primitive-valued global with primitive probe labels', function () {
    const coveredLabels = getCoveredLabelsFromGeneratedTests(this.test);
    const missing = cleanRuntimeLabels.primitiveLabels.filter(
      (label) => !coveredLabels.has(label),
    );
    expect(missing).to.deep.equal([]);
  });
});
