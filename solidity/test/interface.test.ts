/**
 * Interface Checker Unit Tests
 *
 * Run with: pnpm -C solidity test:interface
 *
 * Tests that interface.sh correctly detects breaking changes in:
 * - Function removals
 * - Function return type changes
 * - Event removals
 * - Error removals
 * - Constructor changes
 * - Receive/fallback removals
 */
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SOLIDITY_DIR = join(import.meta.dirname, '..');

// Contract template parts
const CONTRACT_PARTS = {
  header: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InterfaceTestContract {`,

  events: {
    transfer: `event Transfer(address indexed from, address indexed to, uint256 amount);`,
    approval: `event Approval(address indexed owner, address indexed spender, uint256 amount);`,
    newEvent: `event NewEvent(uint256 value);`,
  },

  errors: {
    insufficientBalance: `error InsufficientBalance(uint256 available, uint256 required);`,
    unauthorized: `error Unauthorized(address caller);`,
    newError: `error NewError(string message);`,
  },

  state: `mapping(address => uint256) public balances;`,

  constructors: {
    default: `constructor(uint256 initialSupply) {
        balances[msg.sender] = initialSupply;
    }`,
    modified: `constructor(uint256 initialSupply, address recipient) {
        balances[recipient] = initialSupply;
    }`,
  },

  functions: {
    transfer: `function transfer(address to, uint256 amount) external returns (bool) {
        if (balances[msg.sender] < amount) {
            revert InsufficientBalance(balances[msg.sender], amount);
        }
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }`,
    approve: `function approve(address spender, uint256 amount) external returns (bool) {
        emit Approval(msg.sender, spender, amount);
        return true;
    }`,
    approveNoEmit: `function approve(address spender, uint256 amount) external returns (bool) {
        return true;
    }`,
    balanceOf: `function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }`,
    balanceOfUint128: `function balanceOf(address account) external view returns (uint128) {
        return uint128(balances[account]);
    }`,
    totalSupply: `function totalSupply() external pure returns (uint256) {
        return 1000000;
    }`,
  },

  receive: `receive() external payable { balances[msg.sender] += msg.value; }`,
  fallback: `fallback() external payable { balances[msg.sender] += msg.value; }`,

  footer: `}`,
};

// Helper to build a contract from parts
interface ContractConfig {
  events?: string[];
  errors?: string[];
  constructor?: string;
  functions?: string[];
  receive?: boolean;
  fallback?: boolean;
}

function buildContract(config: ContractConfig): string {
  const parts: string[] = [CONTRACT_PARTS.header];

  // Events
  if (config.events) {
    parts.push('    // Events');
    parts.push(...config.events.map((e) => `    ${e}`));
  }

  // Errors
  if (config.errors) {
    parts.push('    // Errors');
    parts.push(...config.errors.map((e) => `    ${e}`));
  }

  // State
  parts.push('    // State');
  parts.push(`    ${CONTRACT_PARTS.state}`);

  // Constructor
  if (config.constructor) {
    parts.push('    // Constructor');
    parts.push(`    ${config.constructor}`);
  }

  // Functions
  if (config.functions) {
    parts.push('    // Functions');
    parts.push(...config.functions.map((f) => `    ${f}`));
  }

  // Receive
  if (config.receive) {
    parts.push(`    ${CONTRACT_PARTS.receive}`);
  }

  // Fallback
  if (config.fallback) {
    parts.push(`    ${CONTRACT_PARTS.fallback}`);
  }

  parts.push(CONTRACT_PARTS.footer);

  return parts.join('\n');
}

// Base contract configuration
const BASE_CONFIG: ContractConfig = {
  events: [CONTRACT_PARTS.events.transfer, CONTRACT_PARTS.events.approval],
  errors: [
    CONTRACT_PARTS.errors.insufficientBalance,
    CONTRACT_PARTS.errors.unauthorized,
  ],
  constructor: CONTRACT_PARTS.constructors.default,
  functions: [
    CONTRACT_PARTS.functions.transfer,
    CONTRACT_PARTS.functions.approve,
    CONTRACT_PARTS.functions.balanceOf,
  ],
  receive: true,
  fallback: true,
};

const BASE_CONTRACT = buildContract(BASE_CONFIG);

// Contract variants for testing different breaking changes
const CONTRACT_VARIANTS: Record<
  string,
  { contract: string; shouldFail: boolean; expectedMatch: string }
> = {
  function_removed: {
    contract: buildContract({
      ...BASE_CONFIG,
      functions: [
        CONTRACT_PARTS.functions.transfer,
        // approve REMOVED
        CONTRACT_PARTS.functions.balanceOf,
      ],
    }),
    shouldFail: true,
    expectedMatch: 'approve',
  },

  return_type_changed: {
    contract: buildContract({
      ...BASE_CONFIG,
      functions: [
        CONTRACT_PARTS.functions.transfer,
        CONTRACT_PARTS.functions.approve,
        CONTRACT_PARTS.functions.balanceOfUint128, // Return type changed
      ],
    }),
    shouldFail: true,
    expectedMatch: 'balanceOf',
  },

  event_removed: {
    contract: buildContract({
      ...BASE_CONFIG,
      events: [
        CONTRACT_PARTS.events.transfer,
        // Approval event REMOVED
      ],
      functions: [
        CONTRACT_PARTS.functions.transfer,
        CONTRACT_PARTS.functions.approveNoEmit, // Can't emit removed event
        CONTRACT_PARTS.functions.balanceOf,
      ],
    }),
    shouldFail: true,
    expectedMatch: 'Approval',
  },

  error_removed: {
    contract: buildContract({
      ...BASE_CONFIG,
      errors: [
        CONTRACT_PARTS.errors.insufficientBalance,
        // Unauthorized error REMOVED
      ],
    }),
    shouldFail: true,
    expectedMatch: 'Unauthorized',
  },

  constructor_changed: {
    contract: buildContract({
      ...BASE_CONFIG,
      constructor: CONTRACT_PARTS.constructors.modified,
    }),
    shouldFail: true,
    expectedMatch: 'constructor',
  },

  receive_removed: {
    contract: buildContract({
      ...BASE_CONFIG,
      receive: false,
    }),
    shouldFail: true,
    expectedMatch: 'receive',
  },

  fallback_removed: {
    contract: buildContract({
      ...BASE_CONFIG,
      fallback: false,
    }),
    shouldFail: true,
    expectedMatch: 'fallback',
  },

  no_changes: {
    contract: BASE_CONTRACT,
    shouldFail: false,
    expectedMatch: 'No breaking interface changes',
  },

  additions_only: {
    contract: buildContract({
      ...BASE_CONFIG,
      events: [
        CONTRACT_PARTS.events.transfer,
        CONTRACT_PARTS.events.approval,
        CONTRACT_PARTS.events.newEvent, // ADDED
      ],
      errors: [
        CONTRACT_PARTS.errors.insufficientBalance,
        CONTRACT_PARTS.errors.unauthorized,
        CONTRACT_PARTS.errors.newError, // ADDED
      ],
      functions: [
        CONTRACT_PARTS.functions.transfer,
        CONTRACT_PARTS.functions.approve,
        CONTRACT_PARTS.functions.balanceOf,
        CONTRACT_PARTS.functions.totalSupply, // ADDED
      ],
    }),
    shouldFail: false,
    expectedMatch: 'No breaking interface changes',
  },
};

// Test utilities
let testDir: string;
let baseAbiDir: string;
let headAbiDir: string;
const testContractPath = join(
  SOLIDITY_DIR,
  'contracts',
  'test',
  'InterfaceTestContract.sol',
);

function createTestDirs() {
  testDir = join(tmpdir(), `interface-test-${Date.now()}`);
  baseAbiDir = join(testDir, 'base-abi');
  headAbiDir = join(testDir, 'head-abi');

  mkdirSync(testDir, { recursive: true });
  mkdirSync(baseAbiDir, { recursive: true });
  mkdirSync(headAbiDir, { recursive: true });
}

function cleanup() {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
  // Clean up test contract from solidity directory
  if (existsSync(testContractPath)) {
    rmSync(testContractPath, { force: true });
  }
}

function generateAbi(contractCode: string, outputDir: string) {
  // Write contract to solidity/contracts/test/ directory where forge can find it
  writeFileSync(testContractPath, contractCode, 'utf8');

  execSync(
    `forge inspect InterfaceTestContract abi --json > "${outputDir}/InterfaceTestContract-abi.json"`,
    {
      cwd: SOLIDITY_DIR,
      env: { ...process.env },
      stdio: 'pipe',
    },
  );
}

function runInterfaceCheck(): { exitCode: number; output: string } {
  try {
    const output = execSync(
      `./interface.sh test-interface "${baseAbiDir}" "${headAbiDir}"`,
      {
        cwd: SOLIDITY_DIR,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );
    return { exitCode: 0, output };
  } catch (error: any) {
    return {
      exitCode: error.status || 1,
      output: error.stdout || error.stderr || '',
    };
  }
}

// Run tests
console.log('Interface Checker Unit Tests\n');
console.log('='.repeat(60));

let passed = 0;
let failed = 0;

for (const [testName, testCase] of Object.entries(CONTRACT_VARIANTS)) {
  createTestDirs();

  try {
    // Generate base ABI
    generateAbi(BASE_CONTRACT, baseAbiDir);

    // Generate head ABI with the variant
    generateAbi(testCase.contract, headAbiDir);

    // Run interface check
    const result = runInterfaceCheck();

    // Verify result
    const exitCodeCorrect = testCase.shouldFail
      ? result.exitCode === 1
      : result.exitCode === 0;
    const outputCorrect = result.output.includes(testCase.expectedMatch);

    if (exitCodeCorrect && outputCorrect) {
      console.log(`✅ ${testName}`);
      passed++;
    } else {
      console.log(`❌ ${testName}`);
      console.log(`   Expected exit code: ${testCase.shouldFail ? 1 : 0}`);
      console.log(`   Actual exit code: ${result.exitCode}`);
      console.log(`   Expected match: "${testCase.expectedMatch}"`);
      console.log(`   Output contains match: ${outputCorrect}`);
      if (!outputCorrect) {
        console.log(`   Output: ${result.output.slice(0, 200)}...`);
      }
      failed++;
    }
  } catch (error: any) {
    console.log(`❌ ${testName}`);
    console.log(`   Error: ${error.message}`);
    failed++;
  } finally {
    cleanup();
  }
}

console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}

console.log('\nAll interface checker tests passed!');
