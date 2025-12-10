---
paths: solidity/**/*.sol
---

# Solidity Development Rules

## Security Requirements

- Check for reentrancy vulnerabilities in functions that make external calls
- Ensure access control modifiers (`onlyOwner`, etc.) are on privileged functions
- Validate storage collisions when modifying proxy contracts
- Review upgrade safety - new storage variables must be appended, never inserted
- Avoid unchecked arithmetic unless explicitly safe

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
