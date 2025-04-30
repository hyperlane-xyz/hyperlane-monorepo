import prettier from 'prettier';

export async function prettierOutputTransformer(
  output: string,
): Promise<string> {
  return prettier.format(output, { parser: 'typescript' });
}
