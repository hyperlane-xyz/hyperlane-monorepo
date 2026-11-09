import { execFileSync } from 'node:child_process';

import { expect } from 'chai';

describe('native program deployment mapping', () => {
  for (const prefix of ['hyp', 'test_hyp']) {
    for (const skipSuffixes of [false, true]) {
      it(`preserves the native key for ${prefix}, skipSuffixes=${skipSuffixes}`, () => {
        // This setting is captured at module load. Each case needs a fresh module
        // graph, including the real Provable program parser.
        const source = new URL('./helper.node.js', import.meta.url).href;
        const output = execFileSync(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '--eval',
            `import { loadProgramsInDeployOrder } from ${JSON.stringify(source)};
console.log(JSON.stringify(loadProgramsInDeployOrder(${JSON.stringify(prefix)}, 'hyp_native', 'core', 'credits').map(({ id, name }) => ({ id, name }))));`,
          ],
          {
            env: { ...process.env, ALEO_SKIP_SUFFIXES: String(skipSuffixes) },
            encoding: 'utf8',
            timeout: 15000,
            maxBuffer: 1024 * 1024,
          },
        );
        const programs: unknown = JSON.parse(output);
        expect(programs).to.deep.include({
          id: skipSuffixes
            ? `${prefix}_native.aleo`
            : `${prefix}_warp_token_credits.aleo`,
          name: 'hyp_native',
        });
      }).timeout(20000);
    }
  }
});
