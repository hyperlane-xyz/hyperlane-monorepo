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

// Base contract with all ABI elements
const BASE_CONTRACT = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InterfaceTestContract {
    // Events
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    // Errors
    error InsufficientBalance(uint256 available, uint256 required);
    error Unauthorized(address caller);

    // State
    mapping(address => uint256) public balances;

    // Constructor
    constructor(uint256 initialSupply) {
        balances[msg.sender] = initialSupply;
    }

    // Functions
    function transfer(address to, uint256 amount) external returns (bool) {
        if (balances[msg.sender] < amount) {
            revert InsufficientBalance(balances[msg.sender], amount);
        }
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    // Receive function
    receive() external payable {
        balances[msg.sender] += msg.value;
    }

    // Fallback function
    fallback() external payable {
        balances[msg.sender] += msg.value;
    }
}
`;

// Contract variants for testing different breaking changes
const CONTRACT_VARIANTS: Record<
  string,
  { contract: string; shouldFail: boolean; expectedMatch: string }
> = {
  function_removed: {
    contract: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InterfaceTestContract {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    error InsufficientBalance(uint256 available, uint256 required);
    error Unauthorized(address caller);
    mapping(address => uint256) public balances;

    constructor(uint256 initialSupply) {
        balances[msg.sender] = initialSupply;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balances[msg.sender] < amount) {
            revert InsufficientBalance(balances[msg.sender], amount);
        }
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    // approve function REMOVED

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    receive() external payable { balances[msg.sender] += msg.value; }
    fallback() external payable { balances[msg.sender] += msg.value; }
}
`,
    shouldFail: true,
    expectedMatch: 'approve',
  },

  return_type_changed: {
    contract: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InterfaceTestContract {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    error InsufficientBalance(uint256 available, uint256 required);
    error Unauthorized(address caller);
    mapping(address => uint256) public balances;

    constructor(uint256 initialSupply) {
        balances[msg.sender] = initialSupply;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balances[msg.sender] < amount) {
            revert InsufficientBalance(balances[msg.sender], amount);
        }
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    // Return type CHANGED from uint256 to uint128
    function balanceOf(address account) external view returns (uint128) {
        return uint128(balances[account]);
    }

    receive() external payable { balances[msg.sender] += msg.value; }
    fallback() external payable { balances[msg.sender] += msg.value; }
}
`,
    shouldFail: true,
    expectedMatch: 'balanceOf',
  },

  event_removed: {
    contract: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InterfaceTestContract {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    // Approval event REMOVED
    error InsufficientBalance(uint256 available, uint256 required);
    error Unauthorized(address caller);
    mapping(address => uint256) public balances;

    constructor(uint256 initialSupply) {
        balances[msg.sender] = initialSupply;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balances[msg.sender] < amount) {
            revert InsufficientBalance(balances[msg.sender], amount);
        }
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    receive() external payable { balances[msg.sender] += msg.value; }
    fallback() external payable { balances[msg.sender] += msg.value; }
}
`,
    shouldFail: true,
    expectedMatch: 'Approval',
  },

  error_removed: {
    contract: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InterfaceTestContract {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    error InsufficientBalance(uint256 available, uint256 required);
    // Unauthorized error REMOVED
    mapping(address => uint256) public balances;

    constructor(uint256 initialSupply) {
        balances[msg.sender] = initialSupply;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balances[msg.sender] < amount) {
            revert InsufficientBalance(balances[msg.sender], amount);
        }
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    receive() external payable { balances[msg.sender] += msg.value; }
    fallback() external payable { balances[msg.sender] += msg.value; }
}
`,
    shouldFail: true,
    expectedMatch: 'Unauthorized',
  },

  constructor_changed: {
    contract: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InterfaceTestContract {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    error InsufficientBalance(uint256 available, uint256 required);
    error Unauthorized(address caller);
    mapping(address => uint256) public balances;

    // Constructor CHANGED - added parameter
    constructor(uint256 initialSupply, address recipient) {
        balances[recipient] = initialSupply;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balances[msg.sender] < amount) {
            revert InsufficientBalance(balances[msg.sender], amount);
        }
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    receive() external payable { balances[msg.sender] += msg.value; }
    fallback() external payable { balances[msg.sender] += msg.value; }
}
`,
    shouldFail: true,
    expectedMatch: 'constructor',
  },

  receive_removed: {
    contract: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InterfaceTestContract {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    error InsufficientBalance(uint256 available, uint256 required);
    error Unauthorized(address caller);
    mapping(address => uint256) public balances;

    constructor(uint256 initialSupply) {
        balances[msg.sender] = initialSupply;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balances[msg.sender] < amount) {
            revert InsufficientBalance(balances[msg.sender], amount);
        }
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    // receive REMOVED
    fallback() external payable { balances[msg.sender] += msg.value; }
}
`,
    shouldFail: true,
    expectedMatch: 'receive',
  },

  fallback_removed: {
    contract: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InterfaceTestContract {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    error InsufficientBalance(uint256 available, uint256 required);
    error Unauthorized(address caller);
    mapping(address => uint256) public balances;

    constructor(uint256 initialSupply) {
        balances[msg.sender] = initialSupply;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balances[msg.sender] < amount) {
            revert InsufficientBalance(balances[msg.sender], amount);
        }
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    receive() external payable { balances[msg.sender] += msg.value; }
    // fallback REMOVED
}
`,
    shouldFail: true,
    expectedMatch: 'fallback',
  },

  no_changes: {
    contract: BASE_CONTRACT,
    shouldFail: false,
    expectedMatch: 'No breaking interface changes',
  },

  additions_only: {
    contract: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InterfaceTestContract {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event NewEvent(uint256 value); // ADDED
    error InsufficientBalance(uint256 available, uint256 required);
    error Unauthorized(address caller);
    error NewError(string message); // ADDED
    mapping(address => uint256) public balances;

    constructor(uint256 initialSupply) {
        balances[msg.sender] = initialSupply;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balances[msg.sender] < amount) {
            revert InsufficientBalance(balances[msg.sender], amount);
        }
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    // New function ADDED
    function totalSupply() external pure returns (uint256) {
        return 1000000;
    }

    receive() external payable { balances[msg.sender] += msg.value; }
    fallback() external payable { balances[msg.sender] += msg.value; }
}
`,
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
