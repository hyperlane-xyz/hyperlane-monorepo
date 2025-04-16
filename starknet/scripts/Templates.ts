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
    contractExports: string,
    tokenExports: string,
    mockExports: string,
  ) {
    return `
  ${imports}
   export const starknetContracts = {
     contracts: {
   ${contractExports}
     },
     token: {
   ${tokenExports}
     },
     mocks: {
   ${mockExports}
     }
   };
   `;
  }

  static dtsIndex() {
    return `
  import type { CompiledContract, CairoAssembly } from 'starknet';
  
  export interface StarknetContractGroup {
    [name: string]: {
      contract_class?: CompiledContract;
      compiled_contract_class?: CairoAssembly;
    };
  }
  
  export interface StarknetContracts {
    contracts: StarknetContractGroup;
    token: StarknetContractGroup;
    mocks: StarknetContractGroup;
  }
  
  export declare const starknetContracts: StarknetContracts;`;
  }
}
