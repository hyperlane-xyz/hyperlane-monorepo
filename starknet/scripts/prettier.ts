import prettier, { Options as PrettierOptions } from 'prettier';

export const prettierOutputTransformer = (
  output: string,
  config?: { prettier: PrettierOptions },
) => {
  const prettierCfg: PrettierOptions = {
    ...(config?.prettier ?? {}),
    parser: 'typescript',
  };

  return prettier.format(output, prettierCfg);
};
