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
    it('generate: processes artifacts and returns correct ReadonlyProcessedFilesMap', async () => {
      const processedMap: ReadonlyMap<any, any> = await generator.generate();

      expect(processedMap.size).to.equal(3);

      const testInfo = processedMap.get('contracts_Test');
      expect(testInfo).to.deep.equal({
        type: ContractType.CONTRACT,
        sierra: true,
        casm: false, // Assuming only Sierra files are created by mock
      });

      const tokenInfo = processedMap.get('token_HypERC20');
      expect(tokenInfo).to.deep.equal({
        type: ContractType.TOKEN,
        sierra: true,
        casm: false,
      });

      const mockInfo = processedMap.get('mocks_MockContract');
      expect(mockInfo).to.deep.equal({
        type: ContractType.MOCK,
        sierra: true,
        casm: false,
      });

      const indexJsPath = join(TEST_OUTPUT_DIR, 'index.js');
      await fs.access(indexJsPath);
      const testSierraJsPath = join(
        TEST_OUTPUT_DIR,
        `contracts_Test.${ContractClass.SIERRA}.js`,
      );
      await fs.access(testSierraJsPath);
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
