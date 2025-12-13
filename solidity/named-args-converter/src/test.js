/**
 * Test suite for the Solidity Named Arguments Converter
 */
import { FunctionRegistry } from './function-registry.js';
import { Transformer } from './transformer.js';

// Test cases
const testCases = [
  {
    name: 'Simple function call',
    source: `
contract Test {
    function foo(uint256 a, address b) public {}
    function bar() public {
        foo(123, 0x0);
    }
}`,
    expectedChanges: 1,
    checkResult: (result) => {
      return result.source.includes('foo({a: 123, b: 0x0})');
    },
  },
  {
    name: 'Already named arguments - should skip',
    source: `
contract Test {
    function foo(uint256 a, address b) public {}
    function bar() public {
        foo({a: 123, b: 0x0});
    }
}`,
    expectedChanges: 0,
  },
  {
    name: 'External contract call',
    source: `
interface IExternal {
    function transfer(address to, uint256 amount) external;
}

contract Test {
    IExternal ext;
    function bar() public {
        ext.transfer(0x123, 100);
    }
}`,
    expectedChanges: 1,
    checkResult: (result) => {
      return result.source.includes('transfer({to: 0x123, amount: 100})');
    },
  },
  {
    name: 'Skip built-in functions',
    source: `
contract Test {
    function bar() public {
        require(true, "message");
        revert("error");
        bytes32 h = keccak256(abi.encodePacked("test"));
    }
}`,
    expectedChanges: 0,
  },
  {
    name: 'Event emit',
    source: `
contract Test {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    function bar() public {
        emit Transfer(msg.sender, address(0), 100);
    }
}`,
    expectedChanges: 1,
    checkResult: (result) => {
      return result.source.includes(
        'Transfer({from: msg.sender, to: address(0), amount: 100})',
      );
    },
  },
  {
    name: 'Custom error',
    source: `
contract Test {
    error InsufficientBalance(uint256 available, uint256 required);
    function bar() public {
        revert InsufficientBalance(10, 100);
    }
}`,
    expectedChanges: 1,
    checkResult: (result) => {
      return result.source.includes(
        'InsufficientBalance({available: 10, required: 100})',
      );
    },
  },
  {
    name: 'Function with single argument - respects minArgs',
    source: `
contract Test {
    function foo(uint256 a) public {}
    function bar() public {
        foo(123);
    }
}`,
    minArgs: 2,
    expectedChanges: 0,
  },
  {
    name: 'Multiple calls to same function',
    source: `
contract Test {
    function foo(uint256 a, address b) public {}
    function bar() public {
        foo(1, 0x1);
        foo(2, 0x2);
        foo(3, 0x3);
    }
}`,
    expectedChanges: 3,
  },
  {
    name: 'Skip type conversions',
    source: `
contract Test {
    function bar() public {
        address a = address(0x123);
        uint256 b = uint256(100);
    }
}`,
    expectedChanges: 0,
  },
  {
    name: 'Internal function call',
    source: `
contract Test {
    function _internal(uint256 x, uint256 y) internal returns (uint256) {
        return x + y;
    }
    function bar() public {
        _internal(10, 20);
    }
}`,
    expectedChanges: 1,
    checkResult: (result) => {
      return result.source.includes('_internal({x: 10, y: 20})');
    },
  },
  {
    name: 'Library function call',
    source: `
library Math {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b;
    }
}

contract Test {
    using Math for uint256;
    function bar() public {
        Math.add(10, 20);
    }
}`,
    expectedChanges: 1,
    checkResult: (result) => {
      return result.source.includes('add({a: 10, b: 20})');
    },
  },
  {
    name: 'Constructor call',
    source: `
contract Token {
    constructor(string memory name, string memory symbol, uint256 supply) {}
}

contract Test {
    function bar() public {
        new Token("Test", "TST", 1000);
    }
}`,
    expectedChanges: 1,
    checkResult: (result) => {
      return result.source.includes(
        'Token({name: "Test", symbol: "TST", supply: 1000})',
      );
    },
  },
  {
    name: 'Complex expression arguments',
    source: `
contract Test {
    function foo(uint256 a, uint256 b) public {}
    function bar(uint256 x) public {
        foo(x * 2, x + 1);
    }
}`,
    expectedChanges: 1,
    checkResult: (result) => {
      return result.source.includes('foo({a: x * 2, b: x + 1})');
    },
  },
  {
    name: 'Nested function calls',
    source: `
contract Test {
    function foo(uint256 a) public returns (uint256) { return a; }
    function bar(uint256 x, uint256 y) public {}
    function baz() public {
        bar(foo(1), foo(2));
    }
}`,
    expectedChanges: 3, // outer call + 2 inner calls
  },
  {
    name: 'Skip ABI functions',
    source: `
contract Test {
    function bar() public {
        bytes memory data = abi.encode(1, 2, 3);
        abi.encodeWithSelector(bytes4(0), 1, 2);
        abi.encodePacked(1, 2, 3);
    }
}`,
    expectedChanges: 0,
  },
  {
    name: 'Overloaded functions - should match by arg count',
    source: `
contract Test {
    function foo(uint256 a) public {}
    function foo(uint256 a, uint256 b) public {}
    function bar() public {
        foo(1);
        foo(1, 2);
    }
}`,
    expectedChanges: 2,
  },
  {
    name: 'Skip address.transfer built-in',
    source: `
contract Test {
    function foo() public {
        payable(msg.sender).transfer(100);
    }
}`,
    expectedChanges: 0,
  },
  {
    name: 'Skip low-level call built-in',
    source: `
contract Test {
    function foo() public {
        address(this).call{value: 1}("");
    }
}`,
    expectedChanges: 0,
  },
  {
    name: 'Interface function with matching arg count',
    source: `
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract Test {
    IERC20 token;
    function foo() public {
        token.transfer(address(0), 100);
    }
}`,
    expectedChanges: 1,
    checkResult: (result) => {
      return result.source.includes('transfer({to: address(0), amount: 100})');
    },
  },
  {
    name: 'Chained member access',
    source: `
contract A {
    function getB() public returns (B) {}
}
contract B {
    function process(uint256 x, uint256 y) public {}
}
contract Test {
    A a;
    function foo() public {
        a.getB().process(1, 2);
    }
}`,
    // This is more complex - would need deeper type tracking
    // For now, we fall back to global lookup
    expectedChanges: 1,
  },
];

// Run tests
async function runTests() {
  console.log('Running Named Arguments Converter Tests\n');
  console.log('='.repeat(50));

  let passed = 0;
  let failed = 0;

  for (const test of testCases) {
    try {
      // Create fresh registry and transformer for each test
      const registry = new FunctionRegistry();
      registry.parseFile('test.sol', test.source);

      const transformer = new Transformer(registry, {
        minArgs: test.minArgs || 1,
        verbose: false,
      });

      const result = transformer.transform(test.source, 'test.sol');

      // Check expected changes count
      const changesMatch = result.changes.length === test.expectedChanges;

      // Check result if provided
      let resultCheck = true;
      if (test.checkResult && result.changes.length > 0) {
        resultCheck = test.checkResult(result);
      }

      if (changesMatch && resultCheck) {
        console.log(`✅ ${test.name}`);
        passed++;
      } else {
        console.log(`❌ ${test.name}`);
        console.log(
          `   Expected ${test.expectedChanges} changes, got ${result.changes.length}`,
        );
        if (!resultCheck) {
          console.log(`   Result check failed`);
          console.log(`   Output:\n${result.source}`);
        }
        failed++;
      }
    } catch (error) {
      console.log(`❌ ${test.name}`);
      console.log(`   Error: ${error.message}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);

  return failed === 0;
}

// Run if executed directly
runTests().then((success) => {
  process.exit(success ? 0 : 1);
});
