import { expect } from 'chai';

import { moduleRegistry } from '../../src/moduleRegistry.js';

describe('module registry', () => {
  it('retains the known names and leaves unknown modules absent', () => {
    expect(Object.keys(moduleRegistry)).to.deep.equal([
      'callCommitments',
      'cctp',
      'opstack',
    ]);
    expect(moduleRegistry.unknown).to.equal(undefined);
  });

  for (const [name, requiredSetting] of [
    ['callCommitments', 'SERVER_BASE_URL'],
    ['cctp', 'HYPERLANE_EXPLORER_URL'],
    ['opstack', 'HYPERLANE_EXPLORER_API'],
  ] as const) {
    it(`loads ${name} and preserves required configuration validation`, async () => {
      const previous = process.env[requiredSetting];
      delete process.env[requiredSetting];
      let rejected: unknown;
      try {
        await moduleRegistry[name].create(name);
      } catch (error) {
        rejected = error;
      } finally {
        if (previous === undefined) delete process.env[requiredSetting];
        else process.env[requiredSetting] = previous;
      }
      expect(rejected).to.have.property('name', 'ZodError');
      expect(rejected).to.have.nested.property(
        'issues[0].path[0]',
        requiredSetting,
      );
    });
  }
});
