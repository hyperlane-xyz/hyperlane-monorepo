import { expect } from 'chai';
import { promises as fs } from 'fs';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { dirname, join } from 'path';
import sinon from 'sinon';
import { fileURLToPath } from 'url';

import { StarknetArtifactGenerator } from '../../scripts/generate-artifacts.js';
import { CONTRACT_SUFFIXES } from '../../src/const.js';
import { ContractClass, ContractType } from '../../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEST_ROOT = join(__dirname, '../fixtures');
const TEST_RELEASE_DIR = join(TEST_ROOT, 'release');
const TEST_OUTPUT_DIR = join(TEST_ROOT, 'dist/artifacts');

const createMockSierraArtifact = () => ({
  contract_class_version: '0.1.0',
  entry_points_by_type: {
    EXTERNAL: [
      {
        selector:
          '0x52580a92c73f4428f1a260c5d768ef462b25955307de00f99957df119865d',
        function_idx: 11,
      },
    ],
    L1_HANDLER: [],
    CONSTRUCTOR: [
      {
        selector:
          '0x28ffe4ff0f226a9107253e17a904099aa4f63a02a5621de0576e5aa71bc5194',
        function_idx: 12,
      },
    ],
  },
  abi: [
    {
      type: 'interface',
      name: 'contracts::interfaces::IInterchainSecurityModule',
      items: [
        {
          type: 'function',
          name: 'verify',
          inputs: [
            {
              name: '_metadata',
              type: 'alexandria_bytes::bytes::Bytes',
            },
            {
              name: '_message',
              type: 'contracts::libs::message::Message',
            },
          ],
          outputs: [{ type: 'core::bool' }],
          state_mutability: 'view',
        },
      ],
    },
    {
      type: 'function',
      name: 'test_function',
      inputs: [],
      outputs: [{ type: 'felt' }],
    },
  ],
  sierra_program: [1, 2, 3],
});

const TEST_CONTRACTS = [
  { name: 'contracts_Test', type: ContractType.CONTRACT },
  { name: 'token_HypERC20', type: ContractType.TOKEN },
  { name: 'mocks_MockContract', type: ContractType.MOCK },
];

async function createMockContractFiles() {
  for (const contract of TEST_CONTRACTS) {
    const filePath = join(
      TEST_RELEASE_DIR,
      `${contract.name}${CONTRACT_SUFFIXES.SIERRA_JSON}`,
    );
    await fs.writeFile(filePath, JSON.stringify(createMockSierraArtifact()));
  }
}

describe('StarknetArtifactGenerator', () => {
  let generator: StarknetArtifactGenerator;
  let consoleLogStub: sinon.SinonStub;
  let consoleErrorStub: sinon.SinonStub;
  let getArtifactPathsStub: sinon.SinonStub;

  beforeEach(async () => {
    await fs.mkdir(TEST_ROOT, { recursive: true });
    await fs.mkdir(join(TEST_ROOT, 'dist'), { recursive: true });
    await fs.mkdir(TEST_RELEASE_DIR, { recursive: true });
    await fs.mkdir(TEST_OUTPUT_DIR, { recursive: true });

    consoleLogStub = sinon.stub(console, 'log');
    consoleErrorStub = sinon.stub(console, 'error');

    await createMockContractFiles();

    generator = new StarknetArtifactGenerator(
      TEST_RELEASE_DIR,
      TEST_OUTPUT_DIR,
    );

    getArtifactPathsStub = sinon.stub(generator, 'getArtifactPaths');
    getArtifactPathsStub.resolves({
      sierraFiles: TEST_CONTRACTS.map((c) =>
        join(TEST_RELEASE_DIR, `${c.name}${CONTRACT_SUFFIXES.SIERRA_JSON}`),
      ),
    });
  });

  afterEach(async () => {
    consoleLogStub.restore();
    consoleErrorStub.restore();
    getArtifactPathsStub.restore();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  describe('Contract Classification', () => {
    it('correctly identifies contract types from filenames', () => {
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

    it('correctly identifies contract class from path', () => {
      expect(
        generator.getContractClassFromPath('test.compiled_contract_class.json'),
      ).to.equal(ContractClass.CASM);
      expect(
        generator.getContractClassFromPath('test.contract_class.json'),
      ).to.equal(ContractClass.SIERRA);
      expect(() =>
        generator.getContractClassFromPath('test.unknown.json'),
      ).to.throw('Cannot determine contract class from path');
    });
  });

  describe('File Operations', () => {
    it('creates output directory when missing', async () => {
      await fs.rm(TEST_OUTPUT_DIR, { recursive: true, force: true });
      await generator.createOutputDirectory();

      const stats = await fs.stat(TEST_OUTPUT_DIR);
      expect(stats.isDirectory()).to.be.true;
    });

    it('reads and parses artifact files correctly', async () => {
      const filePath = join(
        TEST_RELEASE_DIR,
        `contracts_Test${CONTRACT_SUFFIXES.SIERRA_JSON}`,
      );

      const artifact = await generator.readArtifactFile(filePath);

      expect(artifact).to.deep.include({
        contract_class_version: '0.1.0',
        sierra_program: [1, 2, 3],
      });
      expect(artifact.abi).to.be.a('string');
      expect(JSON.parse(artifact.abi)).to.be.an('array').with.lengthOf(1);
    });
  });

  describe('Content Generation', () => {
    it('extracts only ABI from Sierra contracts', () => {
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
      expect(jsContent).to.not.include('"sierra_program":[1,2,3]');
    });

    it('generates correct TypeScript declaration files', () => {
      const sierraDts = generator.generateDeclarationContent('Test', true);
      expect(sierraDts).to.include(
        'export declare const Test: CompiledContract',
      );

      const casmDts = generator.generateDeclarationContent('Test', false);
      expect(casmDts).to.include('export declare const Test: CairoAssembly');
    });

    it('generates correct index file with categorized contracts', async () => {
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
    it('processes a Sierra artifact file correctly', async () => {
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
  });

  describe('End-to-End Process', () => {
    it('processes all artifacts and generates index files', async () => {
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

      expect(consoleLogStub.calledOnce).to.be.true;
      expect(consoleLogStub.firstCall.args[0]).to.equal(
        'Successfully processed 3 Starknet contracts',
      );
    });
  });

  // TODO: Add test for error handling during artifact processing
  // TODO: Add test for handling malformed artifact files
  // TODO: Add test for handling files with unexpected naming patterns
});
