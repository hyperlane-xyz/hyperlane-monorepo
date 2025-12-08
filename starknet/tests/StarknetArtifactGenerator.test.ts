import { assert, expect } from 'chai';
import { promises as fs } from 'fs';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { StarknetArtifactGenerator } from '../scripts/StarknetArtifactGenerator.js';
import { CONTRACT_SUFFIXES } from '../src/const.js';
import { ContractClass, ContractType } from '../src/types.js';

import { createMockContractFiles, createMockSierraArtifact } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_DIR = join(__dirname, './tmp');
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

  it('should correctly identify contract types from filenames', () => {
    expect(generator.getContractTypeFromPath('token_MyToken.json')).to.equal(
      ContractType.TOKEN,
    );
    expect(
      generator.getContractTypeFromPath('mocks_MockContract.json'),
    ).to.equal(ContractType.MOCK);
    expect(
      generator.getContractTypeFromPath('contracts_IMailbox.json'),
    ).to.equal(ContractType.CONTRACT);
    // Defaults to CONTRACT for unknown prefixes
    expect(generator.getContractTypeFromPath('random_name.json')).to.equal(
      ContractType.CONTRACT,
    );
  });

  it('should create the output directory if it does not exist', async () => {
    await fs.rm(TEST_OUTPUT_DIR, { recursive: true, force: true });
    await generator.createOutputDirectory();
    const stats = await fs.stat(TEST_OUTPUT_DIR);
    expect(stats.isDirectory()).to.be.true;
  });

  it('should read and parse a valid Sierra artifact file', async () => {
    const filePath = join(
      TEST_RELEASE_DIR,
      `contracts_Test${CONTRACT_SUFFIXES.SIERRA_JSON}`,
    );
    const artifact = await generator.readArtifactFile(filePath);
    expect(artifact).to.deep.include({
      contract_class_version: '0.1.0',
      sierra_program: [], // Based on createMockSierraArtifact
    });
    expect(artifact.abi).to.be.an('array');
  });

  it('should generate JS content with expected properties for Sierra contracts', () => {
    const artifact = createMockSierraArtifact();
    const jsContent = generator.generateJavaScriptContent(
      'TestContract',
      artifact,
      ContractClass.SIERRA,
    );

    const jsonMatch = jsContent.match(/^export const \w+ = (\{.*\});$/s);
    assert(jsonMatch, 'Should find exported JSON object in JS content');

    const parsedArtifact = JSON.parse(jsonMatch[1]);
    expect(parsedArtifact).to.be.an('object');
    expect(parsedArtifact)
      .to.have.property('sierra_program')
      .that.is.an('array');
    expect(parsedArtifact)
      .to.have.property('entry_points_by_type')
      .deep.equal(artifact.entry_points_by_type);
    expect(parsedArtifact).to.have.property('abi').that.is.an('array');
    // Check if a specific known item from the mock ABI exists
    const hasTestFunction = parsedArtifact.abi.some(
      (item: any) => item.name === 'test_function',
    );
    expect(hasTestFunction, 'ABI should contain "test_function"').to.be.true;
  });

  it('should generate correct TypeScript declaration for Sierra contracts', () => {
    const dtsContent = generator.generateDeclarationContent(
      'TestSierra',
      true, // isSierra = true
    );
    expect(dtsContent).to.include(
      'export declare const TestSierra: CompiledContract',
    );
  });

  it('should generate correct TypeScript declaration for CASM contracts', () => {
    const dtsContent = generator.generateDeclarationContent(
      'TestCasm',
      false, // isSierra = false
    );
    expect(dtsContent).to.include(
      'export declare const TestCasm: CairoAssembly',
    );
  });

  it('should process a Sierra artifact file correctly, generating JS and DTS files', async () => {
    const fileName = `contracts_Test${CONTRACT_SUFFIXES.SIERRA_JSON}`;
    const filePath = join(TEST_RELEASE_DIR, fileName);
    const artifact = await generator.readArtifactFile(filePath); // Read expected artifact data

    const processResult = await generator.processArtifact(filePath);

    // Verify the returned info object
    expect(processResult).to.deep.equal({
      name: 'contracts_Test',
      contractType: ContractType.CONTRACT,
      contractClass: ContractClass.SIERRA,
    });

    const jsPath = join(
      TEST_OUTPUT_DIR,
      `contracts_Test.${ContractClass.SIERRA}.js`,
    );
    const dtsPath = join(
      TEST_OUTPUT_DIR,
      `contracts_Test.${ContractClass.SIERRA}.d.ts`,
    );
    await fs.access(jsPath); // Throws if file doesn't exist
    await fs.access(dtsPath); // Throws if file doesn't exist

    const jsContent = await fs.readFile(jsPath, 'utf-8');
    const jsonMatch = jsContent.match(/^export const \w+ = (\{.*\});$/s);
    assert(jsonMatch, 'Should find JSON object in generated JS file');
    const parsedJsArtifact = JSON.parse(jsonMatch[1]);

    expect(parsedJsArtifact).to.be.an('object');
    expect(parsedJsArtifact)
      .to.have.property('sierra_program')
      .that.is.an('array');
    expect(parsedJsArtifact).to.have.property(
      'contract_class_version',
      artifact.contract_class_version,
    );
    expect(parsedJsArtifact)
      .to.have.property('entry_points_by_type')
      .deep.equal(artifact.entry_points_by_type);
    expect(parsedJsArtifact)
      .to.have.property('abi')
      .deep.equal(
        typeof artifact.abi === 'string'
          ? JSON.parse(artifact.abi)
          : artifact.abi,
      );

    const dtsContent = await fs.readFile(dtsPath, 'utf-8');
    expect(dtsContent).to.include(
      'export declare const contracts_Test: CompiledContract',
    );
  });

  it('should process a standard set of artifacts, generate index files, and return correct summary', async () => {
    // Assumes beforeEach creates: contracts_Test, token_HypERC20, mocks_MockContract (all Sierra)
    const processedMap = await generator.generate();

    expect(processedMap.size).to.equal(3);
    expect(processedMap.get('contracts_Test')).to.deep.equal({
      type: ContractType.CONTRACT,
      sierra: true,
      casm: false,
    });
    expect(processedMap.get('token_HypERC20')).to.deep.equal({
      type: ContractType.TOKEN,
      sierra: true,
      casm: false,
    });
    expect(processedMap.get('mocks_MockContract')).to.deep.equal({
      type: ContractType.MOCK,
      sierra: true,
      casm: false,
    });

    const indexJsPath = join(TEST_OUTPUT_DIR, 'index.js');
    const indexDtsPath = join(TEST_OUTPUT_DIR, 'index.d.ts');
    await fs.access(indexJsPath);
    await fs.access(indexDtsPath);

    // Check index file content (verify artifact paths are included)
    const indexJsContent = await fs.readFile(indexJsPath, 'utf-8');

    expect(indexJsContent).to.include(
      `./contracts_Test.${ContractClass.SIERRA}.js`,
    );
    expect(indexJsContent).to.include(
      `./token_HypERC20.${ContractClass.SIERRA}.js`,
    );
    expect(indexJsContent).to.include(
      `./mocks_MockContract.${ContractClass.SIERRA}.js`,
    );

    // Check artifact file existence (spot check one)
    const testSierraJsPath = join(
      TEST_OUTPUT_DIR,
      `contracts_Test.${ContractClass.SIERRA}.js`,
    );
    await fs.access(testSierraJsPath);
  });

  it('should handle malformed artifact files gracefully during generation', async () => {
    const malformedFilePath = join(
      TEST_RELEASE_DIR,
      `malformed${CONTRACT_SUFFIXES.SIERRA_JSON}`,
    );
    await fs.writeFile(malformedFilePath, '{ this is not valid JSON }');

    let errorThrown = false;
    try {
      await generator.generate(); // This should throw an error
    } catch (error) {
      errorThrown = true;
      expect(error).to.be.instanceOf(Error);
    }
    // Expect generate() to throw when encountering invalid JSON
    expect(errorThrown, 'Generator should throw an error for malformed JSON').to
      .be.true;
  });

  it('should correctly process artifacts with unusual filenames during generation', async () => {
    // Add a file with an unusual name that still fits the expected suffix pattern
    const oddNamedFilePath = join(
      TEST_RELEASE_DIR,
      `unusual_prefix.contract_class.json`, // Uses SIERRA_JSON suffix
    );
    await fs.writeFile(
      oddNamedFilePath,
      JSON.stringify(createMockSierraArtifact()), // Use valid content
    );

    const processedMap = await generator.generate();

    // Expect 4 total artifacts now (3 standard + 1 unusual)
    expect(processedMap.size).to.equal(4);

    expect(processedMap.has('unusual_prefix')).to.be.true;
    const fileInfo = processedMap.get('unusual_prefix');
    expect(fileInfo).to.deep.equal({
      type: ContractType.CONTRACT, // Default type for unknown prefix
      sierra: true,
      casm: false,
    });

    const jsPath = join(
      TEST_OUTPUT_DIR,
      `unusual_prefix.${ContractClass.SIERRA}.js`,
    );
    const dtsPath = join(
      TEST_OUTPUT_DIR,
      `unusual_prefix.${ContractClass.SIERRA}.d.ts`,
    );
    await fs.access(jsPath);
    await fs.access(dtsPath);

    const indexJsPath = join(TEST_OUTPUT_DIR, 'index.js');
    const indexJsContent = await fs.readFile(indexJsPath, 'utf-8');
    expect(indexJsContent).to.include(
      `./unusual_prefix.${ContractClass.SIERRA}.js`, // Check path inclusion
    );
  });
});
