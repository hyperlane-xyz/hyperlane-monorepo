import { expect } from 'chai';
// eslint-disable-next-line import/no-nodejs-modules -- This test checks build artifacts on disk.
import { statSync } from 'node:fs';

import packageJson from '../package.json' with { type: 'json' };

describe('package exports', () => {
  for (const [subpath, target] of Object.entries(packageJson.exports)) {
    const specifier = packageJson.name + subpath.slice(1);

    it(`resolves ${specifier} to a built file`, () => {
      const resolved = new URL(`../${target}`, import.meta.url);
      expect(
        statSync(resolved, { throwIfNoEntry: false })?.isFile(),
        `Missing built file: ${target}`,
      ).to.equal(true);
    });
  }
});
