export class Templates {
  static tsIndex(
    imports: string[],
    requireImports: string[],
    contractExports: string[],
    tokenExports: string[],
    mockExports: string[],
  ) {
    imports.sort();

    return `
${imports.join('\n')}

${requireImports.join('\n')}

export const starknetContracts = {
  contracts: {
${contractExports.join('\n')}
  },
  token: {
${tokenExports.join('\n')}
  },
  mocks: {
${mockExports.join('\n')}
  },
};
`;
  }

  static dtsIndex() {
    return `import type { CairoAssembly, CompiledContract } from 'starknet';
  
import type { StarknetContracts } from '../types';
export declare const starknetContracts: StarknetContracts;`;
  }
}
