import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { expect } from 'chai';

type InfraPackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function expectNoRipgrepMatches(pattern: string, description: string): void {
  try {
    const output = execFileSync(
      'rg',
      [pattern, 'scripts', 'src', 'config', '--glob', '*.ts'],
      {
        encoding: 'utf8',
      },
    );
    expect.fail(`Found disallowed ${description}:\n${output}`);
  } catch (error) {
    const commandError = error as Error & { status?: number };
    // rg returns exit code 1 when there are no matches.
    if (commandError.status === 1) {
      return;
    }
    throw error;
  }
}

describe('Safe migration guards', () => {
  it('prevents reintroducing infra local safe util imports', () => {
    expectNoRipgrepMatches(
      String.raw`src/utils/safe\.ts|src/utils/safe|from ['"].*utils/safe`,
      'legacy infra safe util import path usage',
    );
  });

  it('keeps @safe-global dependencies out of infra package.json', () => {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const packageJson: InfraPackageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, 'utf8'),
    );

    const allDependencyNames = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ];

    const safeGlobalDeps = allDependencyNames.filter((dep) =>
      dep.startsWith('@safe-global/'),
    );

    expect(safeGlobalDeps).to.deep.equal([]);
  });
});
