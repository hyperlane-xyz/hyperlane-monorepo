# Solidity Named Arguments Converter

A tool to automatically convert Solidity function calls to use named argument syntax.

## Why Named Arguments?

Named arguments make Solidity code more readable and less error-prone:

```solidity
// Before: What do these arguments mean?
dispatch(42, 0x1234..., data, metadata, defaultHook);

// After: Crystal clear!
dispatch({
    destinationDomain: 42,
    recipientAddress: 0x1234...,
    messageBody: data,
    metadata: metadata,
    hook: defaultHook
});
```

Benefits:

- **Readability**: Instantly understand what each argument represents
- **Maintainability**: Easier to add/remove/reorder parameters
- **Safety**: Compiler catches parameter name mismatches
- **Review-friendly**: Code reviews are more effective

## Installation

```bash
cd tools/named-args-converter
yarn install
```

## Usage

### Dry Run (Preview Changes)

```bash
# Preview changes for a single file
node src/cli.js --dry-run ./contracts/Mailbox.sol

# Preview changes for entire directory
node src/cli.js --dry-run ./contracts/
```

### Apply Changes

```bash
# Convert and save changes
node src/cli.js --write ./contracts/

# With verbose output
node src/cli.js --write --verbose ./contracts/

# Show diffs
node src/cli.js --write --show-diff ./contracts/
```

### Options

| Option        | Alias | Default           | Description                               |
| ------------- | ----- | ----------------- | ----------------------------------------- |
| `--write`     | `-w`  | false             | Write changes to files                    |
| `--dry-run`   | `-d`  | true              | Preview changes without writing           |
| `--min-args`  | `-m`  | 1                 | Minimum arguments to require named params |
| `--verbose`   | `-v`  | false             | Show detailed output                      |
| `--pattern`   | `-p`  | `**/*.sol`        | Glob pattern for matching files           |
| `--exclude`   | `-e`  | node_modules, lib | Patterns to exclude                       |
| `--show-diff` |       | false             | Show before/after for each change         |
| `--json`      |       | false             | Output results as JSON                    |

### Examples

```bash
# Only convert calls with 3+ arguments
node src/cli.js --write --min-args 3 ./contracts/

# Convert specific files
node src/cli.js --write --pattern "**/hooks/*.sol" ./contracts/

# Exclude test files
node src/cli.js --write --exclude "**/test/**" ./contracts/

# JSON output for CI/scripting
node src/cli.js --json ./contracts/
```

## How It Works

The converter operates in two passes:

### Pass 1: Build Function Registry

Parses all Solidity files to extract:

- Function definitions with parameter names
- Event definitions
- Custom error definitions
- Interface/library function signatures
- Contract inheritance relationships

### Pass 2: Transform Function Calls

For each function call:

1. Look up the function definition in the registry
2. Match by function name and argument count
3. Generate named argument syntax
4. Preserve original formatting and indentation

## What Gets Converted

✅ **Converted:**

- Regular function calls: `foo(a, b)` → `foo({x: a, y: b})`
- External contract calls: `contract.method(a)` → `contract.method({param: a})`
- Event emissions: `emit Transfer(from, to, amount)`
- Custom error reverts: `revert MyError(code, msg)`
- Constructor calls: `new Contract(a, b)`
- Internal/private function calls
- Library function calls

❌ **Skipped:**

- Already using named arguments
- Built-in functions: `require`, `revert`, `assert`, `keccak256`, etc.
- ABI functions: `abi.encode`, `abi.encodePacked`, etc.
- Type conversions: `address(x)`, `uint256(y)`
- Low-level calls: `call`, `delegatecall`, `staticcall`
- Array operations: `push`, `pop`
- Functions with unnamed parameters

## Handling Edge Cases

### Function Overloading

When multiple overloads exist, the converter matches by argument count:

```solidity
function transfer(address to) external;
function transfer(address to, uint256 amount) external;

// Converts correctly based on arg count
transfer(recipient);          // matches first overload
transfer(recipient, 100);     // matches second overload
```

### Ambiguous Matches

If multiple functions have the same name AND same argument count, the call is skipped to avoid incorrect conversions.

### Missing Definitions

Calls to functions not found in the parsed files are skipped. This includes:

- External library functions (unless imported)
- Functions from contracts not in the conversion scope

## Integration with Solhint

This tool complements the `func-named-parameters` solhint rule:

1. **Detect**: Use solhint with `func-named-parameters` to find violations
2. **Fix**: Use this converter to automatically fix them
3. **Enforce**: Keep the solhint rule enabled to prevent regressions

```json
// .solhintrc
{
  "rules": {
    "func-named-parameters": ["warn", 4]
  }
}
```

## API Usage

```javascript
import { NamedArgsConverter } from '@hyperlane-xyz/named-args-converter';

const converter = new NamedArgsConverter({
  minArgs: 3,
  write: true,
  verbose: true,
});

// Convert a directory
const summary = await converter.convertDirectory('./contracts');
console.log(`Converted ${summary.totalChanges} function calls`);

// Or convert a single file
const result = await converter.convertFile('./contracts/MyContract.sol');
console.log(result.source); // Transformed source code
```

## Testing

```bash
node src/test.js
```

## Foundry Artifacts

The converter automatically detects and parses Foundry build artifacts from `out/` directory. This provides function definitions for all compiled contracts including external dependencies (OpenZeppelin, Arbitrum, etc.) without needing to manually specify include paths.

Make sure to run `forge build` before using the converter to ensure artifacts are up to date.

## Limitations

1. **Source-level transformation**: Works on source code, not compiled bytecode
2. **Requires function definitions**: Can't convert calls to unknown functions (run `forge build` first to generate Foundry artifacts)
3. **No semantic analysis**: Doesn't verify type compatibility
4. **Single-file scope**: Each file is transformed independently
5. **Nested/chained calls**: When function calls are nested (e.g., `foo(bar(x))`) or chained (e.g., `a().b()`), only the innermost call is converted to avoid position corruption
6. **Type resolution**: Variable types are tracked for state variables (including inherited) and local declarations. Complex type inference (e.g., return types of function calls, storage mappings) is not supported.

## License

Apache-2.0
