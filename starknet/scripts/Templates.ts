export class Templates {
  static jsArtifact(name: string, artifact: any) {
    return `export const ${name} = ${JSON.stringify(artifact)};`;
  }

  static dtsArtifact(name: string, type: string) {
    return `
      import type { CompiledContract, CairoAssembly } from 'starknet';
      export declare const ${name}: ${type};
      `;
  }

  static jsIndex(
    imports: string,
    contractExports: string[],
    tokenExports: string[],
    mockExports: string[],
  ) {
    return `
${imports}

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
