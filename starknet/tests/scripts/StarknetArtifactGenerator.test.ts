import { expect } from 'chai';
import { promises as fs } from 'fs';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { StarknetArtifactGenerator } from '../../scripts/StarknetArtifactGenerator.js';
import { CONTRACT_SUFFIXES } from '../../src/const.js';
import { ContractClass, ContractType } from '../../src/types.js';

import {
  createMockContractFiles,
  createMockSierraArtifact,
} from './mock-sierra.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_DIR = join(__dirname, '../tmp');
const TEST_RELEASE_DIR = join(TMP_DIR, 'release');
const TEST_OUTPUT_DIR = join(TMP_DIR, 'dist/artifacts');

describe('StarknetArtifactGenerator', () => {
  let generator: StarknetArtifactGenerator;

  beforeEach(async () => {
    await Promise.all([
      fs.mkdir(TMP_DIR, { recursive: true }),
      fs.mkdir(TEST_RELEASE_DIR, { recursive: true }),
      fs.mkdir(TEST_OUTPUT_DIR, { recursive: true }),
    ]);

    await createMockContractFiles(TEST_RELEASE_DIR);

    generator = new StarknetArtifactGenerator(
      TEST_RELEASE_DIR,
      TEST_OUTPUT_DIR,
    );
  });

  afterEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  });

  describe('Contract Classification', () => {
    it('getContractTypeFromPath: correctly identifies contract types from filenames', () => {
      expect(generator.getContractTypeFromPath('token_MyToken.json')).to.equal(
        ContractType.TOKEN,
      );
      expect(
        generator.getContractTypeFromPath('mocks_MockContract.json'),
      ).to.equal(ContractType.MOCK);
      expect(
        generator.getContractTypeFromPath('contracts_IMailbox.json'),
      ).to.equal(ContractType.CONTRACT);
      expect(generator.getContractTypeFromPath('random_name.json')).to.equal(
        ContractType.CONTRACT,
      );
    });
  });

  describe('File Operations', () => {
    it('createOutputDirectory: creates output directory when missing', async () => {
      await fs.rm(TEST_OUTPUT_DIR, { recursive: true, force: true });
      await generator.createOutputDirectory();

      const stats = await fs.stat(TEST_OUTPUT_DIR);
      expect(stats.isDirectory()).to.be.true;
    });

    it('readArtifactFile: reads and parses artifact files correctly', async () => {
      const filePath = join(
        TEST_RELEASE_DIR,
        `contracts_Test${CONTRACT_SUFFIXES.SIERRA_JSON}`,
      );

      const artifact = await generator.readArtifactFile(filePath);

      expect(artifact).to.deep.include({
        contract_class_version: '0.1.0',
        sierra_program: [],
      });
      expect(artifact.abi).to.be.an('array');
    });
  });

  describe('Content Generation', () => {
    it('generateJavaScriptContent: extracts only ABI from Sierra contracts', () => {
      const artifact = createMockSierraArtifact();
      const jsContent = generator.generateJavaScriptContent(
        'Test',
        artifact,
        ContractClass.SIERRA,
      );

      expect(jsContent).to.include('export const Test =');
      expect(jsContent).to.include('sierra_program');
      expect(jsContent).to.include('contract_class_version');
      expect(jsContent).to.include('"abi":');
      expect(jsContent).to.include('test_function');
      expect(jsContent).to.include('"sierra_program":[]');
    });

    it('generateDeclarationContent: generates correct TypeScript declaration files', () => {
      const sierraDts = generator.generateDeclarationContent('Test', true);
      expect(sierraDts).to.include(
        'export declare const Test: CompiledContract',
      );

      const casmDts = generator.generateDeclarationContent('Test', false);
      expect(casmDts).to.include('export declare const Test: CairoAssembly');
    });
  });

  describe('Artifact Processing', () => {
    it('processArtifact: processes a Sierra artifact file correctly', async () => {
      const filePath = join(
        TEST_RELEASE_DIR,
        `contracts_Test${CONTRACT_SUFFIXES.SIERRA_JSON}`,
      );

      await generator.processArtifact(filePath);

      const fileInfo = generator['processedFiles'].get('contracts_Test');
      expect(fileInfo).to.deep.equal({
        type: ContractType.CONTRACT,
        sierra: true,
        casm: false,
      });

      const jsPath = join(
        TEST_OUTPUT_DIR,
        `contracts_Test.${ContractClass.SIERRA}.js`,
      );
      const dtsPath = join(
        TEST_OUTPUT_DIR,
        `contracts_Test.${ContractClass.SIERRA}.d.ts`,
      );

      await fs.access(jsPath);
      await fs.access(dtsPath);

      const jsContent = await fs.readFile(jsPath, 'utf-8');
      expect(jsContent).to.include('export const contracts_Test =');
      expect(jsContent).to.include('"sierra_program":[]');
    });

    it('generate: handles malformed artifact files', async () => {
      const malformedFilePath = join(
        TEST_RELEASE_DIR,
        `malformed${CONTRACT_SUFFIXES.SIERRA_JSON}`,
      );
      await fs.writeFile(malformedFilePath, '{ this is not valid JSON }');
      let errorThrown = false;
      try {
        await generator.generate();
      } catch {
        errorThrown = true;
      }
      expect(errorThrown).to.be.true;
    });
  });

  describe('End-to-End Process', () => {
    // it('generate: processes artifacts and produces correct index files', async () => {
    //   // Define expectations based on files known to be created by createMockContractFiles
    //   const expectedOutputs = [
    //     {
    //       fileName: `contracts_Test${CONTRACT_SUFFIXES.SIERRA_JSON}`,
    //       fullName: 'contracts_Test',
    //       strippedName: 'Test',
    //       type: ContractType.CONTRACT,
    //       classType: ContractClass.SIERRA,
    //       classSuffix: 'contract_class',
    //     },
    //     {
    //       fileName: `token_HypERC20${CONTRACT_SUFFIXES.SIERRA_JSON}`,
    //       fullName: 'token_HypERC20',
    //       strippedName: 'HypERC20',
    //       type: ContractType.TOKEN,
    //       classType: ContractClass.SIERRA,
    //       classSuffix: 'contract_class',
    //     },
    //     {
    //       fileName: `mocks_MockContract${CONTRACT_SUFFIXES.SIERRA_JSON}`,
    //       fullName: 'mocks_MockContract',
    //       strippedName: 'MockContract',
    //       type: ContractType.MOCK,
    //       classType: ContractClass.SIERRA,
    //       classSuffix: 'contract_class',
    //     },
    //     // Add CASM expectations if mock files include them and they should be indexed
    //   ];

    //   // Call the main generate method - this processes artifacts and writes index files
    //   await generator.generate();

    //   // Verify the expected number of files were processed (based on createMockContractFiles)
    //   expect(generator['processedFiles'].size).to.equal(expectedOutputs.length);

    //   // Read the generated index files
    //   const indexJsPath = join(TEST_OUTPUT_DIR, 'index.js');
    //   const indexDtsPath = join(TEST_OUTPUT_DIR, 'index.d.ts');

    //   // Ensure files exist before reading
    //   await Promise.all([fs.access(indexJsPath), fs.access(indexDtsPath)]);

    //   const [jsContent, dtsContent] = await Promise.all([
    //     fs.readFile(indexJsPath, 'utf-8'),
    //     fs.readFile(indexDtsPath, 'utf-8'),
    //   ]);

    //   // Helper regex functions (refined based on actual index.js output)
    //   const importPattern = (
    //     fullName: string,
    //     strippedName: string,
    //     type: ContractType,
    //     classSuffix: string,
    //   ) => {
    //     const aliasSuffix =
    //       classSuffix === 'contract_class' ? 'sierra' : 'casm';
    //     const importAlias = `${type}_${strippedName}_${aliasSuffix}`;
    //     return new RegExp(
    //       `import\\s*{\\s*${fullName}\\s+as\\s+${importAlias}\\s*}\\s*from\\s*'\\.\\/${fullName}\\.${classSuffix}\\.js';`,
    //       'm',
    //     );
    //   };

    //   const exportPattern = (
    //     strippedName: string,
    //     type: ContractType,
    //     classSuffix: string,
    //   ) => {
    //     const aliasSuffix =
    //       classSuffix === 'contract_class' ? 'sierra' : 'casm';
    //     const variableName = `${type}_${strippedName}_${aliasSuffix}`;
    //     const exportKey = classSuffix;
    //     return new RegExp(
    //       `${strippedName}\\s*:\\s*{\\s*${exportKey}\\s*:\\s*${variableName}\\s*},?`,
    //       'm',
    //     );
    //   };

    //   // Assertions based on expected outputs
    //   expectedOutputs.forEach((eo) => {
    //     // Check JS imports in the generated index.js
    //     expect(
    //       importPattern(
    //         eo.fullName,
    //         eo.strippedName,
    //         eo.type,
    //         eo.classSuffix,
    //       ).test(jsContent),
    //       `JS Import for ${eo.fullName} (${eo.classSuffix}) failed in index.js`,
    //     ).to.be.true;

    //     // Check JS exports within the correct category in index.js
    //     const categoryRegex = new RegExp(
    //       `export const starknetContracts =\\s*{[\\s\\S]*?${eo.type}:\\s*{([\\s\\S]*?)}[\\s\\S]*?};`,
    //       'm',
    //     );
    //     const categoryMatch = jsContent.match(categoryRegex);
    //     expect(
    //       categoryMatch,
    //       `Category '${eo.type}' not found in index.js export`,
    //     ).to.exist;

    //     if (categoryMatch) {
    //       const categoryContent = categoryMatch[1];
    //       expect(
    //         exportPattern(eo.strippedName, eo.type, eo.classSuffix).test(
    //           categoryContent,
    //         ),
    //         `JS Export for ${eo.strippedName} (${eo.classSuffix}) in category ${eo.type} failed in index.js`,
    //       ).to.be.true;
    //     }

    //     // Check DTS exports in the generated index.d.ts
    //     const dtsExportKey =
    //       eo.classType === ContractClass.SIERRA
    //         ? 'contract_class: CompiledContract;'
    //         : 'compiled_contract_class: CairoAssembly;';
    //     expect(dtsContent).to.match(
    //       new RegExp(
    //         `${eo.type}:\\s*{[\\s\\S]*?${eo.strippedName}:\\s*{\\s*${dtsExportKey}\\s*}[\\s\\S]*?};`,
    //         'm',
    //       ),
    //       `DTS Export for ${eo.strippedName} in category ${eo.type} failed in index.d.ts`,
    //     );
    //   });

    //   // Overall structure assertions on file content
    //   expect(jsContent).to.include('export const starknetContracts =');
    //   expect(jsContent).to.include('contracts: {');
    //   expect(jsContent).to.include('token: {');
    //   expect(jsContent).to.include('mocks: {');

    //   expect(dtsContent).to.include('export interface StarknetContracts');
    //   expect(dtsContent).to.include(
    //     'export declare const starknetContracts: StarknetContracts',
    //   );
    // });

    it('getArtifactPaths/processArtifact: handles files with unexpected naming patterns', async () => {
      const oddNamedFilePath = join(
        TEST_RELEASE_DIR,
        'unusual_name.contract_class.json',
      );
      await fs.writeFile(
        oddNamedFilePath,
        JSON.stringify(createMockSierraArtifact()),
      );

      await generator.generate();

      expect(generator['processedFiles'].size).to.equal(4);
      expect(generator['processedFiles'].has('unusual_name')).to.be.true;

      const fileInfo = generator['processedFiles'].get('unusual_name');
      expect(fileInfo?.type).to.equal(ContractType.CONTRACT);
      expect(fileInfo?.sierra).to.be.true;

      const jsPath = join(
        TEST_OUTPUT_DIR,
        `unusual_name.${ContractClass.SIERRA}.js`,
      );
      const dtsPath = join(
        TEST_OUTPUT_DIR,
        `unusual_name.${ContractClass.SIERRA}.d.ts`,
      );

      await fs.access(jsPath);
      await fs.access(dtsPath);
    });
  });
});
