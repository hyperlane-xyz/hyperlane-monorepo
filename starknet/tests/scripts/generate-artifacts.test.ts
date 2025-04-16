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
    await fs.mkdir(TMP_DIR, { recursive: true });
    await fs.mkdir(join(TMP_DIR, 'dist'), { recursive: true });
    await fs.mkdir(TEST_RELEASE_DIR, { recursive: true });
    await fs.mkdir(TEST_OUTPUT_DIR, { recursive: true });

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

    it('generateIndexContents: generates correct index file with categorized contracts', async () => {
      const processedFiles = generator['processedFiles'];

      const CONTRACT_NAME = 'contracts_Test';
      const TOKEN_NAME = 'token_HypERC20';
      const MOCK_NAME = 'mocks_MockContract';

      const STRIPPED_CONTRACT_NAME = 'Test';
      const STRIPPED_TOKEN_NAME = 'HypERC20';
      const STRIPPED_MOCK_NAME = 'MockContract';

      processedFiles.set('contracts_Test', {
        type: ContractType.CONTRACT,
        sierra: true,
        casm: false,
      });
      processedFiles.set('token_HypERC20', {
        type: ContractType.TOKEN,
        sierra: true,
        casm: false,
      });
      processedFiles.set('mocks_MockContract', {
        type: ContractType.MOCK,
        sierra: true,
        casm: false,
      });

      const { jsContent, dtsContent } = generator.generateIndexContents();

      const importPattern = (name: string) =>
        new RegExp(`import\\s+{\\s*${name}\\s+as\\s+${name}_sierra\\s*}`);

      expect(importPattern(CONTRACT_NAME).test(jsContent)).to.be.true;
      expect(importPattern(TOKEN_NAME).test(jsContent)).to.be.true;
      expect(importPattern(MOCK_NAME).test(jsContent)).to.be.true;

      const exportPattern = (strippedName: string, fullName: string) =>
        new RegExp(
          `${strippedName}:\\s*{\\s*contract_class:\\s*${fullName}_sierra\\s*}`,
        );

      expect(
        exportPattern(STRIPPED_CONTRACT_NAME, CONTRACT_NAME).test(jsContent),
      ).to.be.true;
      expect(exportPattern(STRIPPED_TOKEN_NAME, TOKEN_NAME).test(jsContent)).to
        .be.true;
      expect(exportPattern(STRIPPED_MOCK_NAME, MOCK_NAME).test(jsContent)).to.be
        .true;

      expect(dtsContent).to.include('export interface StarknetContracts');
      expect(dtsContent).to.include(
        'export declare const starknetContracts: StarknetContracts',
      );
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

      try {
        await generator.generate();
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.an('Error');
      }
    });
  });

  describe('End-to-End Process', () => {
    it('generate: processes all artifacts and generates index files', async () => {
      await generator.generate();

      expect(generator['processedFiles'].size).to.equal(3);

      const indexJs = await fs.readFile(
        join(TEST_OUTPUT_DIR, 'index.js'),
        'utf-8',
      );
      const indexDts = await fs.readFile(
        join(TEST_OUTPUT_DIR, 'index.d.ts'),
        'utf-8',
      );

      expect(indexJs).to.include('export const starknetContracts =');
      expect(indexDts).to.include(
        'export declare const starknetContracts: StarknetContracts',
      );
    });

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
