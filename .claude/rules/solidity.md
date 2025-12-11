---
paths: solidity/**/*.sol
---

# Solidity Development Rules

## Security Requirements

Based on [Solcurity Standard](https://github.com/transmissions11/solcurity):

### Core Principles

- Preserve backward compatibility of interfaces and storage layout unless absolutely necessary
- Check for reentrancy vulnerabilities - follow checks-effects-interactions pattern (SWC-107)
- Ensure access control modifiers (`onlyOwner`, etc.) are on privileged functions
- Avoid unchecked arithmetic unless explicitly safe (SWC-101)

### Variables & Storage

- Set visibility explicitly on all variables (SWC-108)
- Pack storage variables when possible (adjacent smaller types)
- Use `constant` for compile-time values, `immutable` for constructor-set values
- Use 256-bit types except when packing for gas efficiency
- Never shadow state variables (SWC-119)

### Functions

- Use `external` visibility when function is only called externally
- Validate all parameters within safe bounds
- Follow checks-before-effects pattern to prevent reentrancy
- Check for front-running vulnerabilities (SWC-114)
- Ensure return values are always assigned
- Don't assume `msg.sender` is the operated-upon user

### External Calls

- Verify external call necessity and assess DoS risk from errors (SWC-113)
- Check harmlessness if reentering current or other functions
- Use SafeERC20 or safely check return values for token transfers
- Use `.call{value: ...}("")` instead of `transfer`/`send` (SWC-134)
- Check contract existence before low-level calls
- Don't assume success implies function existence (phantom functions)

### Math & Data

- Multiply before dividing (unless overflow risk)
- Document precision loss and which actors benefit/suffer
- Use `abi.encode()` over `abi.encodePacked()` for dynamic types (SWC-133)
- Protect signatures with nonce and `block.chainid` (SWC-121)
- Implement EIP-712 for signature standards (SWC-117, SWC-122)

### Events

- Emit events for all storage mutations
- Index action creator and operated-upon users/IDs
- Never index dynamic types (strings, bytes)
- Avoid function calls in event arguments

### Code Quality

- Replace magic numbers with named constants
- Use named arguments for functions with many parameters
- Document `unchecked` blocks with gas savings reasoning
- Use `delete` keyword for zero-value assignments
- Minimize inheritance to reduce complexity (SWC-125)

### DeFi-Specific

- Don't use AMM spot price as oracle
- Separate internal accounting from actual balances
- Document rebasing token, fee-on-transfer, and ERC-777 support status
- Use sanity checks against price manipulation
- Prevent arbitrary calls from user input in approval targets

## Testing

- Run `yarn --cwd solidity test` for both Hardhat and Forge tests
- Use `forge test --match-test <pattern>` to run specific tests
- Generate fixtures with `yarn --cwd solidity fixtures` before running Forge tests
- Run `yarn --cwd solidity gas` to check gas snapshots for regressions

## Code Style

- Follow existing naming conventions in the codebase
- Use NatSpec comments for public/external functions
- Prefer composition over inheritance where practical
- Keep functions focused and single-purpose

## Key Contracts

- `Mailbox.sol` - Central hub for message dispatch/process
- `isms/` - Interchain Security Modules for verification
- `hooks/` - Post-dispatch hooks (gas payments, merkle tree)
- `token/` - Warp route implementations (HypERC20, HypERC20Collateral)
