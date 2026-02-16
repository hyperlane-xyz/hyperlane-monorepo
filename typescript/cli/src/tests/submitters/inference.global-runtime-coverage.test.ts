import { execFileSync } from 'child_process';

import { expect } from 'chai';

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
        const match = title.match(
          /(?:caches(?: event-derived)?(?: async)? )([a-z0-9_-]+-(?:constructor-)?object) origin signer probes across timelock ICA inferences/,
        );
        if (match?.[1]) coveredLabels.add(match[1]);
      }
      suiteStack.push(...(suite?.suites ?? []));
    }

    return coveredLabels;
  };

  const getCleanRuntimeLabels = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--no-warnings',
          '-e',
          `
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
            process.stdout.write(JSON.stringify({ functionLabels, objectLabels }));
          `,
        ],
        { encoding: 'utf8' },
      ),
    ) as { functionLabels: string[]; objectLabels: string[] };

  it('covers every runtime function-valued global with constructor probe labels', function () {
    const coveredLabels = getCoveredLabelsFromGeneratedTests(this.test);
    const runtimeLabels = getCleanRuntimeLabels().functionLabels;
    const missing = runtimeLabels.filter((label) => !coveredLabels.has(label));
    expect(missing).to.deep.equal([]);
  });

  it('covers every runtime object-valued global with object probe labels', function () {
    const coveredLabels = getCoveredLabelsFromGeneratedTests(this.test);
    const runtimeLabels = getCleanRuntimeLabels().objectLabels;
    const missing = runtimeLabels.filter((label) => !coveredLabels.has(label));
    expect(missing).to.deep.equal([]);
  });
});
