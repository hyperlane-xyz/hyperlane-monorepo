import { promises as fs } from 'fs';
import prettier from 'prettier';

export async function prettierOutputTransformer(
  output: string,
): Promise<string> {
  return prettier.format(output, { parser: 'typescript' });
}

export async function prettierFileTransformer(filePath: string): Promise<void> {
  const content = await fs.readFile(filePath, 'utf-8');
  await fs.writeFile(
    filePath,
    await prettier.format(content, { parser: 'typescript', singleQuote: true }),
  );
}
