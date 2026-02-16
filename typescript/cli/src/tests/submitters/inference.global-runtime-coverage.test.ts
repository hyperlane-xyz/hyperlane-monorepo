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
          /(?:caches(?: event-derived)?(?: async)? )([a-z0-9_-]+-(?:constructor-)?object|[a-z0-9_-]+-primitive) origin signer probes across timelock ICA inferences/,
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
            const primitiveLabels = Object.getOwnPropertyNames(globalThis)
              .filter((name) => {
                const value = globalThis[name];
                return [
                  'string',
                  'number',
                  'boolean',
                  'bigint',
                  'undefined',
                  'symbol',
                ].includes(typeof value);
              })
              .map((name) => \`\${name.toLowerCase()}-\${typeof globalThis[name]}-primitive\`)
              .sort();
            process.stdout.write(JSON.stringify({ functionLabels, objectLabels, primitiveLabels }));
          `,
        ],
        { encoding: 'utf8' },
      ),
    ) as {
      functionLabels: string[];
      objectLabels: string[];
      primitiveLabels: string[];
    };

  const cleanRuntimeLabels = getCleanRuntimeLabels();

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
