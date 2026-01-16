---
name: testing-patterns
description: Test-Driven Development patterns, factory functions, mocking strategies. Use when writing tests, creating test utilities, or following TDD workflow.
---

# Testing Patterns for Hyperlane

## When to Use

- Writing new tests
- Creating mock data or factories
- Setting up test fixtures
- Following TDD red-green-refactor cycle
- Debugging test failures

## TDD Workflow

### Red-Green-Refactor Cycle

1. **RED**: Write a failing test first
2. **GREEN**: Write minimal code to make it pass
3. **REFACTOR**: Clean up while keeping tests green

### Example

```typescript
// 1. RED - Write the test first
describe('WarpCore', () => {
  it('should calculate transfer fee correctly', () => {
    const warpCore = new WarpCore(mockMultiProvider);
    const fee = warpCore.getTransferFee('ethereum', 'arbitrum', 1000n);
    expect(fee).toBe(expectedFee);
  });
});

// 2. GREEN - Implement minimal code to pass
// 3. REFACTOR - Clean up implementation
```

## Factory Functions

Always use factory functions for test data to ensure consistency and reduce duplication.

### TypeScript Factory Pattern

```typescript
// Good - Factory with defaults and overrides
function createMockChainMetadata(
  overrides?: Partial<ChainMetadata>,
): ChainMetadata {
  return {
    name: 'test-chain',
    chainId: 1,
    domainId: 1,
    protocol: ProtocolType.Ethereum,
    rpcUrls: [{ http: 'http://localhost:8545' }],
    ...overrides,
  };
}

// Usage
const chain = createMockChainMetadata({ name: 'arbitrum', chainId: 42161 });
```

### Solidity Factory Pattern (Forge)

```solidity
function _createTestMessage() internal pure returns (bytes memory) {
  return
    abi.encodePacked(
      uint8(3), // version
      uint32(1), // nonce
      uint32(1), // origin
      bytes32(0), // sender
      uint32(2), // destination
      bytes32(0), // recipient
      bytes('test body') // body
    );
}
```

## Mocking Strategies

### TypeScript Mocking

```typescript
// Mock MultiProvider
const mockMultiProvider = {
  getChainMetadata: jest.fn().mockReturnValue(mockChainMetadata),
  getProvider: jest.fn().mockReturnValue(mockProvider),
  getSigner: jest.fn().mockReturnValue(mockSigner),
} as unknown as MultiProvider;

// Mock contract calls
jest.spyOn(contract, 'dispatch').mockResolvedValue(mockTxReceipt);
```

### Solidity Mocking (Forge)

```solidity
// Use vm.mockCall for external contracts
vm.mockCall(
    address(mailbox),
    abi.encodeWithSelector(IMailbox.dispatch.selector),
    abi.encode(messageId)
);

// Use vm.prank for caller impersonation
vm.prank(owner);
mailbox.setDefaultIsm(newIsm);
```

## Test Organization

### Describe Blocks

```typescript
describe('ClassName', () => {
  describe('methodName', () => {
    it('should handle normal case', () => {});
    it('should handle edge case', () => {});
    it('should throw on invalid input', () => {});
  });
});
```

### Arrange-Act-Assert

```typescript
it('should transfer tokens correctly', async () => {
  // Arrange
  const amount = 1000n;
  const recipient = '0x...';

  // Act
  const result = await warpCore.transfer(amount, recipient);

  // Assert
  expect(result.status).toBe('success');
  expect(result.amount).toBe(amount);
});
```

## Anti-Patterns to Avoid

1. **Don't test implementation details** - Test behavior, not internal state
2. **Don't skip factory functions** - Leads to duplicated, inconsistent test data
3. **Don't mock what you don't own** - Mock at boundaries, not deep internals
4. **Don't write tests after the fact** - TDD catches bugs earlier

## Project-Specific Patterns

### SDK Tests

- Location: `typescript/sdk/src/**/*.test.ts`
- Run: `pnpm -C typescript/sdk test`
- Use `MultiProvider` mocks from existing test utilities

### Solidity Tests (Forge)

- Location: `solidity/test/**/*.t.sol`
- Run: `pnpm -C solidity test:forge`
- Generate fixtures first: `pnpm -C solidity fixtures`

### CLI E2E Tests

- Location: `typescript/cli/src/**/*.e2e-test.ts`
- Run: `pnpm -C typescript/cli test:ethereum:e2e`
- Use anvil for local chain testing
