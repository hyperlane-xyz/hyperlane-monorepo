import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { expect } from 'chai';

describe('resolveSubmitterBatchesForTransactions global runtime probe coverage', () => {
  it('covers every runtime function-valued global with constructor probe labels', () => {
    const submitterTestDir = path.join(process.cwd(), 'src/tests/submitters');
    const coveredLabels = new Set<string>();

    for (const fileName of fs.readdirSync(submitterTestDir)) {
      if (!fileName.startsWith('inference.') || !fileName.endsWith('.test.ts')) {
        continue;
      }

      const fileContent = fs.readFileSync(
        path.join(submitterTestDir, fileName),
        'utf8',
      );
      for (const match of fileContent.matchAll(
        /[a-z0-9-]+-constructor-object/g,
      )) {
        coveredLabels.add(match[0]);
      }
    }

    const runtimeLabels = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--no-warnings',
          '-e',
          `
            const labels = Object.getOwnPropertyNames(globalThis)
              .filter((name) => typeof globalThis[name] === 'function')
              .map((name) => \`\${name.toLowerCase()}-constructor-object\`)
              .sort();
            process.stdout.write(JSON.stringify(labels));
          `,
        ],
        { encoding: 'utf8' },
      ),
    ) as string[];

    const missing = runtimeLabels.filter((label) => !coveredLabels.has(label));

    expect(missing).to.deep.equal([]);
  });
});
