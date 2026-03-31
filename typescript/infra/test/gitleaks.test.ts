import { Keypair } from '@solana/web3.js';
import { expect } from 'chai';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  TomlTable,
  parse as parseToml,
  stringify as stringifyToml,
} from 'smol-toml';

import { bufferToBase58, setEquality } from '@hyperlane-xyz/utils';
import { readFileAtPath, writeToFile } from '@hyperlane-xyz/utils/fs';

describe('GitLeaks CLI Integration Tests', function () {
  let tempDir: string;
  let configPath: string;
  let ruleIds: string[];

  let gitLeaksConfig: TomlTable;

  before(function () {
    const originalConfigPath = path.join(
      process.cwd(),
      '../../',
      '.gitleaks.toml',
    );

    if (!fs.existsSync(originalConfigPath)) {
      throw new Error(
        `GitLeaks config not found at ${originalConfigPath}. Please ensure gitleaks.toml exists in the project root.`,
      );
    }

    // Remove the allowlist from the original file to allow secret detection from the temporary file
    gitLeaksConfig = parseToml(readFileAtPath(originalConfigPath));
    delete gitLeaksConfig.allowlist;

    ruleIds = (gitLeaksConfig.rules as Array<{ id: string }>).map(
      ({ id }) => id,
    );
  });

  beforeEach(function () {
    // Create temporary directory and write the config
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitleaks-test-'));
    configPath = path.join(tempDir, 'test-gitleaks.toml');
    writeToFile(configPath, stringifyToml(gitLeaksConfig));
  });

  afterEach(function () {
    // Clean up temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function generateSvmPrivateKey(): string {
    return bufferToBase58(Buffer.from(generateBufferSvmPrivateKey()));
  }

  function generateBufferSvmPrivateKey(): Uint8Array {
    return Keypair.generate().secretKey;
  }

  interface GitLeaksResult {
    Description: string;
    StartLine: number;
    EndLine: number;
    StartColumn: number;
    EndColumn: number;
    Match: string;
    Secret: string;
    File: string;
    SymlinkFile: string;
    Commit: string;
    Entropy: number;
    Author: string;
    Email: string;
    Date: string;
    Message: string;
    Tags: string[];
    RuleID: string;
    Fingerprint: string;
  }

  interface BaseTestCase {
    name: string;
    content: string;
    description?: string;
  }

  interface SuccessTestCase extends BaseTestCase {
    expectedRuleId: string;
    expectedCount?: number;
  }

  interface FailureTestCase extends BaseTestCase {}

  interface RuleTestGroup {
    ruleId: string;
    ruleName: string;
    successTestCases: SuccessTestCase[];
    failureTestCases: FailureTestCase[];
  }

  function runGitleaksSuccessTest(testCase: SuccessTestCase): void {
    const testFilePath = path.join(tempDir, 'test-file.js');
    writeToFile(testFilePath, testCase.content);

    const reportPath = path.join(tempDir, 'gitleaks-report.json');

    try {
      execSync(
        `gitleaks directory "${tempDir}" --config="${configPath}" --report-format=json --report-path="${reportPath}" --no-banner`,
        { encoding: 'utf8', stdio: 'pipe' },
      );

      throw new Error(
        `Expected gitleaks to find secrets but it returned success for test: ${testCase.name}`,
      );
    } catch (error: any) {
      if (error.status === 1) {
        // Gitleaks found secrets (exit code 1) - this is expected
        let results: GitLeaksResult[] = [];
        try {
          // Read results from the report file
          if (fs.existsSync(reportPath)) {
            const reportContent = fs.readFileSync(reportPath, 'utf8');
            if (reportContent.trim()) {
              results = JSON.parse(reportContent) as GitLeaksResult[];
            }
          } else {
            throw new Error(
              `Gitleaks report file not found at ${reportPath} for test ${testCase.name}`,
            );
          }
        } catch (parseError) {
          throw new Error(
            `Failed to parse gitleaks JSON report for test ${testCase.name}: ${parseError}`,
          );
        }

        // Validate results
        expect(results).to.have.length.greaterThan(
          0,
          `Expected to find secrets but got empty results for test: ${testCase.name}`,
        );

        const ruleIds = results.map((r) => r.RuleID);
        expect(ruleIds).to.include(
          testCase.expectedRuleId,
          `Expected rule ID ${testCase.expectedRuleId} but found: ${ruleIds.join(', ')}`,
        );

        if (testCase.expectedCount) {
          expect(results).to.have.length(
            testCase.expectedCount,
            `Expected ${testCase.expectedCount} results but got ${results.length}`,
          );
        }
      } else {
        throw new Error(
          `Gitleaks execution failed for test ${testCase.name}: ${error.message}`,
        );
      }
    }
  }

  function runGitleaksFailureTest(testCase: FailureTestCase): void {
    const testFilePath = path.join(tempDir, 'test-file.js');
    writeToFile(testFilePath, testCase.content);

    const reportPath = path.join(tempDir, 'gitleaks-report.json');

    try {
      execSync(
        `gitleaks directory "${tempDir}" --config="${configPath}" --report-format=json --report-path="${reportPath}" --no-banner`,
        { encoding: 'utf8', stdio: 'pipe' },
      );

      // No secrets found, which was expected
      return;
    } catch (error: any) {
      if (error.status === 1) {
        // Gitleaks found secrets (exit code 1) - this is unexpected for failure tests
        throw new Error(
          `Gitleaks unexpectedly found secrets for test: ${testCase.name}`,
        );
      } else {
        throw new Error(
          `Gitleaks execution failed for test ${testCase.name}: ${error.message}`,
        );
      }
    }
  }

  // Test data organized by rule
  const ruleTestGroups: RuleTestGroup[] = [
    {
      ruleId: 'alchemy-api-key',
      ruleName: 'Alchemy API Key Detection',
      successTestCases: [
        {
          name: 'should detect Alchemy API key in JavaScript config',
          content: `const config = { rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/your-api-key-here" };`,
          expectedRuleId: 'alchemy-api-key',
        },
        {
          name: 'should detect Alchemy API key in environment file',
          content: `ALCHEMY_URL=https://polygon-mainnet.g.alchemy.com/v2/abc123def456`,
          expectedRuleId: 'alchemy-api-key',
        },
        {
          name: 'should detect Alchemy API key in JSON',
          content: `{ "providers": { "alchemy": "https://arbitrum-mainnet.g.alchemy.com/v2/test-key-123" } }`,
          expectedRuleId: 'alchemy-api-key',
        },
      ],
      failureTestCases: [
        {
          name: 'should not detect invalid Alchemy URL (missing subdomain)',
          content: `const config = { rpcUrl: "https://alchemy.com/v2/not-a-real-api-key" };`,
        },
        {
          name: 'should not detect invalid Alchemy URL (wrong version)',
          content: `const config = { rpcUrl: "https://eth-mainnet.g.alchemy.com/v3/api-key" };`,
        },
        {
          name: 'should not detect Alchemy docs URL',
          content: `const docs = "https://docs.alchemy.com/guides";`,
        },
      ],
    },
    {
      ruleId: 'ankr-api-key',
      ruleName: 'Ankr API Key Detection',
      successTestCases: [
        {
          name: 'should detect Ankr API key',
          content: `export const ANKR_RPC = "https://rpc.ankr.com/eth/your-api-key";`,
          expectedRuleId: 'ankr-api-key',
        },
        {
          name: 'should detect Ankr API key with different network',
          content: `const polygonRpc = "https://rpc.ankr.com/polygon/abc123_def-456";`,
          expectedRuleId: 'ankr-api-key',
        },
        {
          name: 'should detect Ankr API key in YAML',
          content: `networks:\n  mainnet: "https://rpc.ankr.com/arbitrum/test-key"`,
          expectedRuleId: 'ankr-api-key',
        },
      ],
      failureTestCases: [
        {
          name: 'should not detect invalid Ankr URL (missing rpc subdomain)',
          content: `const url = "https://ankr.com/eth/api-key";`,
        },
        {
          name: 'should not detect incomplete Ankr URL',
          content: `const url = "https://rpc.ankr.com/api-key";`,
        },
      ],
    },
    {
      ruleId: 'tenderly-api-key',
      ruleName: 'Tenderly API Key Detection',
      successTestCases: [
        {
          name: 'should detect Tenderly API key in JSON',
          content: `{ "rpc": "https://mainnet.gateway.tenderly.co/your-api-key" }`,
          expectedRuleId: 'tenderly-api-key',
        },
        {
          name: 'should detect Tenderly API key with network prefix',
          content: `const rpc = "https://polygon-mainnet.gateway.tenderly.co/abc123_def-456";`,
          expectedRuleId: 'tenderly-api-key',
        },
        {
          name: 'should detect Tenderly API key with complex subdomain',
          content: `rpcUrl: "https://test-network.gateway.tenderly.co/key123"`,
          expectedRuleId: 'tenderly-api-key',
        },
      ],
      failureTestCases: [
        {
          name: 'should not detect invalid Tenderly URL (missing gateway)',
          content: `const url = "https://tenderly.co/api-key";`,
        },
        {
          name: 'should not detect invalid Tenderly URL (wrong subdomain)',
          content: `const url = "https://mainnet.tenderly.co/api-key";`,
        },
      ],
    },
    {
      ruleId: 'quicknode-api-key',
      ruleName: 'QuickNode API Key Detection',
      successTestCases: [
        {
          name: 'should detect QuickNode API key',
          content: `const provider = new ethers.providers.JsonRpcProvider("https://mainnet.ethereum.quiknode.pro/abc123def456");`,
          expectedRuleId: 'quicknode-api-key',
        },
        {
          name: 'should detect QuickNode API key with different network',
          content: `const rpc = "https://polygon-main.rpc.quiknode.pro/def456";`,
          expectedRuleId: 'quicknode-api-key',
        },
        {
          name: 'should detect QuickNode API key with hyphenated subdomain',
          content: `endpoint: "https://test-node.arbitrum.quiknode.pro/xyz789"`,
          expectedRuleId: 'quicknode-api-key',
        },
      ],
      failureTestCases: [
        {
          name: 'should not detect invalid QuickNode URL (missing second subdomain)',
          content: `const url = "https://quiknode.pro/abc123";`,
        },
        {
          name: 'should not detect invalid QuickNode URL (single subdomain)',
          content: `const url = "https://mainnet.quiknode.pro/abc123";`,
        },
      ],
    },
    {
      ruleId: 'drpc-api-key',
      ruleName: 'DRPC API Key Detection',
      successTestCases: [
        {
          name: 'should detect DRPC API key with dkey parameter',
          content: `const rpcUrl = "https://lb.drpc.org/ogrpc?network=ethereum&dkey=your-secret-key";`,
          expectedRuleId: 'drpc-api-key',
        },
        {
          name: 'should detect DRPC API key with multiple parameters',
          content: `const url = "https://lb.drpc.org/oghttp?network=polygon&dkey=def456&other=param";`,
          expectedRuleId: 'drpc-api-key',
        },
        {
          name: 'should detect DRPC API key with dkey at end',
          content: `rpc: "https://lb.drpc.org/endpoint123?param=value&dkey=xyz789"`,
          expectedRuleId: 'drpc-api-key',
        },
      ],
      failureTestCases: [
        {
          name: 'should not detect invalid DRPC URL (missing lb subdomain)',
          content: `const url = "https://drpc.org/ogrpc?dkey=abc123";`,
        },
        {
          name: 'should not detect DRPC URL without dkey parameter',
          content: `const url = "https://lb.drpc.org/ogrpc?network=ethereum";`,
        },
      ],
    },
    {
      ruleId: 'dwellir-api-key',
      ruleName: 'Dwellir API Key Detection',
      successTestCases: [
        {
          name: 'should detect Dwellir API key',
          content: `DWELLIR_API=https://api-mainnet.dwellir.com/your-api-key`,
          expectedRuleId: 'dwellir-api-key',
        },
        {
          name: 'should detect Dwellir API key with complex subdomain',
          content: `const rpc = "https://api-polygon-mainnet.dwellir.com/def456";`,
          expectedRuleId: 'dwellir-api-key',
        },
        {
          name: 'should detect Dwellir API key with hyphenated path',
          content: `endpoint: "https://api-test.dwellir.com/xyz-789"`,
          expectedRuleId: 'dwellir-api-key',
        },
      ],
      failureTestCases: [
        {
          name: 'should not detect invalid Dwellir URL (missing api prefix)',
          content: `const url = "https://dwellir.com/abc123";`,
        },
        {
          name: 'should not detect invalid Dwellir URL (wrong subdomain)',
          content: `const url = "https://mainnet.dwellir.com/abc123";`,
        },
      ],
    },
    {
      ruleId: 'startale-api-key',
      ruleName: 'Startale API Key Detection',
      successTestCases: [
        {
          name: 'should detect Startale API key',
          content: `const rpc = "https://mainnet.startale.com/rpc?apikey=secretkey123";`,
          expectedRuleId: 'startale-api-key',
        },
        {
          name: 'should detect Startale API key with path',
          content: `const url = "https://test-network.startale.com/api/v1?apikey=def456";`,
          expectedRuleId: 'startale-api-key',
        },
        {
          name: 'should detect Startale API key with multiple parameters',
          content: `rpc: "https://polygon.rpc.startale.com?param=value&apikey=xyz789"`,
          expectedRuleId: 'startale-api-key',
        },
      ],
      failureTestCases: [
        {
          name: 'should not detect invalid Startale URL (missing subdomain)',
          content: `const url = "https://startale.com?apikey=abc123";`,
        },
        {
          name: 'should not detect Startale URL without apikey',
          content: `const url = "https://mainnet.startale.com/rpc?key=abc123";`,
        },
      ],
    },
    {
      ruleId: 'grove-city-api-key',
      ruleName: 'Grove City API Key Detection',
      successTestCases: [
        {
          name: 'should detect Grove City API key',
          content: `fetch("https://mainnet.rpc.grove.city/v1/your-api-key")`,
          expectedRuleId: 'grove-city-api-key',
        },
        {
          name: 'should detect Grove City API key with network prefix',
          content: `const rpc = "https://polygon-mainnet.rpc.grove.city/v1/def456";`,
          expectedRuleId: 'grove-city-api-key',
        },
        {
          name: 'should detect Grove City API key with hyphenated subdomain',
          content: `endpoint: "https://test-network.rpc.grove.city/v1/xyz789"`,
          expectedRuleId: 'grove-city-api-key',
        },
      ],
      failureTestCases: [
        {
          name: 'should not detect invalid Grove City URL (missing rpc subdomain)',
          content: `const url = "https://grove.city/v1/abc123";`,
        },
        {
          name: 'should not detect invalid Grove City URL (wrong subdomain)',
          content: `const url = "https://mainnet.grove.city/v1/abc123";`,
        },
      ],
    },
    {
      ruleId: 'ccvalidators-api-key',
      ruleName: 'CryptoCrew API Key Detection',
      successTestCases: [
        {
          name: 'should detect CCValidators RPC endpoint',
          content: `const rpcEndpoint = "https://rpc.mainnet.ccvalidators.com:443/cosmos";`,
          expectedRuleId: 'ccvalidators-api-key',
        },
        {
          name: 'should detect CCValidators GRPC endpoint',
          content: `grpc: "https://grpc.polygon.ccvalidators.com"`,
          expectedRuleId: 'ccvalidators-api-key',
        },
        {
          name: 'should detect CCValidators REST endpoint with port',
          content: `rest: "https://rest.arbitrum.ccvalidators.com:9090"`,
          expectedRuleId: 'ccvalidators-api-key',
        },
        {
          name: 'should detect CCValidators endpoint with path',
          content: `endpoint: "https://rpc.test-network.ccvalidators.com/api-endpoint"`,
          expectedRuleId: 'ccvalidators-api-key',
        },
      ],
      failureTestCases: [
        {
          name: 'should not detect invalid CCValidators URL (wrong prefix)',
          content: `const url = "https://api.mainnet.ccvalidators.com";`,
        },
        {
          name: 'should not detect invalid CCValidators URL (missing subdomain)',
          content: `const url = "https://ccvalidators.com";`,
        },
      ],
    },
    {
      ruleId: 'ccnodes-api-key',
      ruleName: 'CryptoCrew Nodes API Key Detection',
      successTestCases: [
        {
          name: 'should detect CCNodes API endpoint',
          content: `grpcEndpoint: "https://polygon.grpc.ccnodes.com:9090"`,
          expectedRuleId: 'ccnodes-api-key',
        },
        {
          name: 'should detect CCNodes endpoint without port',
          content: `const rpc = "https://mainnet.rpc.ccnodes.com";`,
          expectedRuleId: 'ccnodes-api-key',
        },
        {
          name: 'should detect CCNodes endpoint with path',
          content: `rest: "https://arbitrum.rest.ccnodes.com/cosmos"`,
          expectedRuleId: 'ccnodes-api-key',
        },
        {
          name: 'should detect CCNodes endpoint with port and path',
          content: `api: "https://test-network.api.ccnodes.com:443/endpoint"`,
          expectedRuleId: 'ccnodes-api-key',
        },
      ],
      failureTestCases: [
        {
          name: 'should not detect invalid CCNodes URL (single subdomain)',
          content: `const url = "https://mainnet.ccnodes.com";`,
        },
        {
          name: 'should not detect invalid CCNodes URL (no subdomain)',
          content: `const url = "https://ccnodes.com";`,
        },
      ],
    },
    {
      ruleId: 'svm-cli-private-key',
      ruleName: 'Solana CLI Private Key Detection',
      successTestCases: [
        {
          name: 'should detect Solana CLI private key (compact byte array)',
          content: `const keypair = [174,47,154,16,202,193,206,113,199,190,53,133,169,175,31,56,222,53,138,189,224,216,117,173,10,149,53,45,73,228,128,239,168,187,184,9,166,75,164,42,11,58,142,55,91,112,101,50,6,169,105,178,118,191,165,17,138,149,85,184,157,86,205,37];`,
          expectedRuleId: 'svm-cli-private-key',
        },
        {
          name: 'should detect Solana CLI private key (formatted with whitespace)',
          content: `const keypair = [
                      174, 47, 154, 16, 202, 193, 206, 113, 199, 190, 53, 133, 169, 175, 31, 56,
                      222, 53, 138, 189, 224, 216, 117, 173, 10, 149, 53, 45, 73, 228, 128, 239,
                      168, 187, 184, 9, 166, 75, 164, 42, 11, 58, 142, 55, 91, 112, 101, 50,
                      6, 169, 105, 178, 118, 191, 165, 17, 138, 149, 85, 184, 157, 86, 205, 37
                    ];`,
          expectedRuleId: 'svm-cli-private-key',
        },
        {
          name: 'should detect Solana CLI private key (irregular spacing)',
          content: `const key = [ 255,0,128,64,32,16,8,4,2,1,255,0,128,64,32,16,8,4,2,1,255,0,128,64,32,16,8,4,2,1,255,0,128,64,32,16,8,4,2,1,255,0,128,64,32,16,8,4,2,1,255,0,128,64,32,16,8,4,2,1,255,0,128,64 ];`,
          expectedRuleId: 'svm-cli-private-key',
        },
        {
          name: 'should detect Solana CLI private key in JSON config',
          content: `{
                      "keypairs": {
                        "wallet1": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64]
                      }
                    }`,
          expectedRuleId: 'svm-cli-private-key',
        },
      ],
      failureTestCases: [
        {
          name: 'should not detect array too short (63 elements)',
          content: `const shortArray = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63];`,
        },
        {
          name: 'should not detect array too long (65 elements)',
          content: `const longArray = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65];`,
        },
        {
          name: 'should not detect regular short array',
          content: `const shortArray = [1, 2, 3, 4, 5];`,
        },
      ],
    },
    {
      ruleId: 'svm-base58-private-key',
      ruleName: 'Solana Base58 Private Key Detection',
      successTestCases: [
        {
          name: 'should detect Solana Base58 private key',
          content: `${generateSvmPrivateKey()}`,
          expectedRuleId: 'svm-base58-private-key',
        },
        {
          name: 'should detect Solana Base58 private key in a js file',
          content: `const privateKey = "${generateSvmPrivateKey()}";`,
          expectedRuleId: 'svm-base58-private-key',
        },
        {
          name: 'should detect Base58 key in JSON wallet config',
          content: `{
                      "wallet": {
                        "privateKey": "${generateSvmPrivateKey()}"
                      }
                    }`,
          expectedRuleId: 'svm-base58-private-key',
        },
        {
          name: 'should detect Base58 key in environment variable',
          content: `SOLANA_PRIVATE_KEY=${generateSvmPrivateKey()}`,
          expectedRuleId: 'svm-base58-private-key',
        },
        {
          name: 'should detect Base58 key with mixed case',
          content: `const key = "${generateSvmPrivateKey()}";`,
          expectedRuleId: 'svm-base58-private-key',
        },
      ],
      failureTestCases: [
        {
          name: 'should not detect Base58 key too short',
          content: `const invalidKey = "${generateSvmPrivateKey().slice(0, -2)}";`,
        },
        {
          name: 'should not detect Base58 key too long',
          content: `const invalidKey = "${generateSvmPrivateKey()}eVe";`,
        },
        {
          name: 'should not detect Base58 key with invalid character 0',
          content: `const invalidKey = "${generateSvmPrivateKey().slice(0, -1)}0";`,
        },
        {
          name: 'should not detect Base58 key with invalid character O',
          content: `const invalidKey = "${generateSvmPrivateKey().slice(0, -1)}O";`,
        },
        {
          name: 'should not detect Base58 key with invalid character I',
          content: `const invalidKey = "${generateSvmPrivateKey().slice(0, -1)}I";`,
        },
        {
          name: 'should not detect Base58 key with invalid character l',
          content: `const invalidKey = "${generateSvmPrivateKey().slice(0, -1)}l";`,
        },
      ],
    },
  ];

  it('Rule ids in the configuration file and in the test cases match', function () {
    const ruleIdsInTestCases = ruleTestGroups.map(({ ruleId }) => ruleId);

    expect(
      setEquality(new Set(ruleIds), new Set(ruleIdsInTestCases)),
      'Expected rule ids in gitleaks config file to match rule ids in test cases',
    ).to.be.true;
  });

  // Generate tests for each rule
  ruleTestGroups.forEach((ruleGroup) => {
    describe(ruleGroup.ruleName, function () {
      ruleGroup.successTestCases.forEach((testCase) => {
        it(testCase.name, function () {
          runGitleaksSuccessTest(testCase);
        });
      });

      ruleGroup.failureTestCases.forEach((testCase) => {
        it(testCase.name, function () {
          runGitleaksFailureTest(testCase);
        });
      });
    });
  });

  describe('Combined Scenarios', function () {
    const combinedSuccessTestCases: SuccessTestCase[] = [
      {
        name: 'should detect multiple different secrets in one file',
        content: `export const config = {
  alchemy: "https://eth-mainnet.g.alchemy.com/v2/secret-key",
  ankr: "https://rpc.ankr.com/eth/another-secret",
  tenderly: "https://mainnet.gateway.tenderly.co/tenderly-key",
  solanaWallet: "${generateSvmPrivateKey()}",
  solanaKeypair: [${Array.from(generateBufferSvmPrivateKey()).join(',')}]
};`,
        expectedRuleId: 'alchemy-api-key',
        expectedCount: 5,
      },
      {
        name: 'should detect mixed format Solana keys',
        content: `const wallets = {
  wallet1: "${generateSvmPrivateKey()}",
  wallet2: [${Array.from(generateBufferSvmPrivateKey()).join(',')}]
};`,
        expectedRuleId: 'svm-base58-private-key',
        expectedCount: 2,
      },
    ];

    const combinedFailureTestCases: FailureTestCase[] = [
      {
        name: 'should not detect secrets in safe content',
        content: `const config = {
  apiUrl: "https://example.com/api/v1",
  timeout: 5000,
  retries: 3,
  normalArray: [1, 2, 3, 4, 5],
  docs: "https://docs.example.com",
  regularString: "AbCdEfGhJkMnPqRsUvWx" // too short for base58
};`,
      },
      {
        name: 'should prevent false positives with similar but safe URLs',
        content: `const urls = {
  docs: "https://docs.alchemy.com",
  ankrDocs: "https://ankr.com/docs",
  example: "https://example.g.alchemy.com/v2/", // Missing API key
  almostValid: "https://rpc.ankr.com/api-key", // Missing network
  tenderlyDocs: "https://docs.tenderly.co/guides"
};`,
      },
    ];

    combinedSuccessTestCases.forEach((testCase) => {
      it(testCase.name, function () {
        runGitleaksSuccessTest(testCase);
      });
    });

    combinedFailureTestCases.forEach((testCase) => {
      it(testCase.name, function () {
        runGitleaksFailureTest(testCase);
      });
    });
  });
});
