import { expect } from 'chai';
import { describe, it } from 'mocha';

import { Templates } from '../../scripts/Templates.js';

describe('Templates', () => {
  describe('jsArtifact', () => {
    it('should generate correct JS content for an artifact', () => {
      const name = 'TestContract';
      const artifact = {
        abi: [{ name: 'test_func' }],
        sierra_program: ['0x1', '0x2'],
        contract_class_version: '0.1.0',
      };
      const expectedOutput = `export const ${name} = ${JSON.stringify(
        artifact,
      )};`;

      const result = Templates.jsArtifact(name, artifact);
      expect(result).to.equal(expectedOutput);
    });
  });

  describe('dtsArtifact', () => {
    it('should generate correct DTS content for CompiledContract type', () => {
      const name = 'SierraContract';
      const type = 'CompiledContract';
      const result = Templates.dtsArtifact(name, type);

      expect(result).to.include(
        `import type { CompiledContract, CairoAssembly } from 'starknet';`,
      );
      expect(result).to.include(`export declare const ${name}: ${type};`);
    });

    it('should generate correct DTS content for CairoAssembly type', () => {
      const name = 'CasmContract';
      const type = 'CairoAssembly';
      const result = Templates.dtsArtifact(name, type);

      expect(result).to.include(
        `import type { CompiledContract, CairoAssembly } from 'starknet';`,
      );
      expect(result).to.include(`export declare const ${name}: ${type};`);
    });
  });

  describe('jsIndex', () => {
    it('should generate correct JS index file content', () => {
      const imports = `import { A as A_sierra } from './A.sierra.js';\nimport { B as B_sierra } from './B.sierra.js';`;
      const contractExports = `A: { contract_class: A_sierra },`;
      const tokenExports = `B: { contract_class: B_sierra },`;
      const mockExports = ``; // Empty for this test

      const result = Templates.jsIndex(
        imports,
        contractExports,
        tokenExports,
        mockExports,
      );

      // Check for the overall structure and interpolation
      expect(result).to.include(imports);
      expect(result).to.include('export const starknetContracts = {');
      expect(result).to.include('contracts: {');
      expect(result).to.include(contractExports);
      expect(result).to.include('token: {');
      expect(result).to.include(tokenExports);
      expect(result).to.include('mocks: {');
      expect(result).to.include(mockExports); // Should correctly interpolate empty string
      expect(result).to.include('};'); // Closing brace
    });
  });

  describe('dtsIndex', () => {
    it('should generate correct DTS index file content', () => {
      const result = Templates.dtsIndex();

      // Check for key declarations and interfaces
      expect(result).to.include(
        `import type { CompiledContract, CairoAssembly } from 'starknet';`,
      );
      expect(result).to.include('export interface StarknetContractGroup {');
      expect(result).to.include('contract_class?: CompiledContract;');
      expect(result).to.include('compiled_contract_class?: CairoAssembly;');
      expect(result).to.include('export interface StarknetContracts {');
      expect(result).to.include('contracts: StarknetContractGroup;');
      expect(result).to.include('token: StarknetContractGroup;');
      expect(result).to.include('mocks: StarknetContractGroup;');
      expect(result).to.include(
        'export declare const starknetContracts: StarknetContracts;',
      );
    });
  });
});
