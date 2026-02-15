import { execFileSync } from 'child_process';

import { expect } from 'chai';

function expectNoRipgrepMatches(pattern: string, description: string): void {
  try {
    const output = execFileSync(
      'rg',
      [pattern, 'scripts', 'src', 'config', '--glob', '*.ts'],
      { encoding: 'utf8' },
    );
    expect.fail(`Found disallowed ${description}:\n${output}`);
  } catch (error) {
    const commandError = error as Error & { status?: number };
    // rg exits with 1 when no matches are found.
    if (commandError.status === 1) {
      return;
    }
    throw error;
  }
}

describe('Error logging hardening guards', () => {
  it('prevents catch(console.error/rootLogger.error) handlers', () => {
    expectNoRipgrepMatches(
      String.raw`\.catch\((rootLogger\.error|console\.error)\)`,
      '.catch(console.error/rootLogger.error) handlers',
    );
  });

  it('prevents direct identifier error logging calls', () => {
    expectNoRipgrepMatches(
      String.raw`console\.error\(\s*(err|error|e)\s*\)|rootLogger\.error\(\s*(err|error|e)\s*\)|rootLogger\.warn\(\s*(err|error|e)\s*\)`,
      'direct error object logging calls',
    );
  });

  it('prevents comma-style raw error logging arguments', () => {
    expectNoRipgrepMatches(
      String.raw`rootLogger\.error\([^\n]*,\s*(err|error|e)\)|console\.error\([^\n]*,\s*(err|error|e)\)|rootLogger\.warn\([^\n]*,\s*(err|error|e)\)`,
      'comma-style raw error arguments in logs',
    );
  });

  it('prevents direct .message/.stack error accessor usage', () => {
    expectNoRipgrepMatches(
      String.raw`\berror\.message\b|\berr\.message\b|\be\.message\b|\berror\.stack\b|\berr\.stack\b|\be\.stack\b`,
      'direct .message/.stack error accessor usage',
    );
  });
});
