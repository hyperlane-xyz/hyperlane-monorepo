import prettier, { Options as PrettierOptions } from 'prettier';

export const prettierOutputTransformer = (output: string) => {
  const prettierCfg: PrettierOptions = {
    parser: 'typescript',
  };

  return prettier.format(output, prettierCfg);
};
