import { execSync } from 'child_process';

export async function prettierOutputTransformer(
  output: string,
): Promise<string> {
  return execSync('pnpm exec oxfmt --stdin-filepath generated.ts', {
    input: output,
    encoding: 'utf-8',
  });
}
