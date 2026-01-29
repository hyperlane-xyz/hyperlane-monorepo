# Gas Drop Feature Implementation Plan

## Overview

Enable gas drop (delivering native tokens to recipients on destination chains) as an opt-in, composable feature. This solves the UX problem of users not having gas to transact after bridging tokens to a new chain.

## Design Principles

1. **Composable** - Gas drop via ValueRequestHook, not baked into warp routes
2. **Application-controlled** - Each app configures its own gas drop value per destination
3. **Relayer-limited** - IGP's `maxDestinationValue` provides safety cap (0 = disabled)
4. **Simulation-based delivery** - Relayer simulates with value, falls back without if recipient can't receive ETH

## Architecture

### Message Flow

```
Origin Chain:
1. User calls warpRoute.transferRemote()
2. Router dispatches with hook metadata (msgValue = 0 by default)
3. RoutingHook routes to ValueRequestHook for destination
4. ValueRequestHook injects msgValue into metadata, delegates to inner hook
5. IGP.postDispatch() reads msgValue, validates against maxDestinationValue
6. IGP emits ValueRequested(messageId, value) and includes value in quote

Off-chain:
7. Relayer sees ValueRequested event, extracts value amount
8. Relayer simulates process{value: X}() on destination
9. If simulation succeeds, submit with value; otherwise submit without

Destination Chain:
10. Mailbox.process{value}() calls recipient.handle{value}()
11. TokenRouter._handle() forwards msg.value to token recipient via sendValue()
```

### Hook Tree (Example Setup)

```
WarpRoute
  └─→ hook = RoutingHook
              ├─→ chainA → ValueRequestHook(innerHook=IGP, value=0.001 ETH)
              ├─→ chainB → ValueRequestHook(innerHook=IGP, value=0.0001 ETH)
              └─→ chainC → IGP (no gas drop)
```

## Implementation

### Solidity Changes

#### 1. ValueRequestHook Contract (NEW)

**File:** `solidity/contracts/hooks/ValueRequestHook.sol`

Immutable hook that injects a configured value into hook metadata:

- Takes `innerHook` and `value` in constructor
- Overrides `msgValue` in metadata before delegating to inner hook
- Adds `value` to quote dispatch result
- Returns `VALUE_REQUEST` hook type

```solidity
contract ValueRequestHook is AbstractPostDispatchHook {
  IPostDispatchHook public immutable innerHook;
  uint256 public immutable value;

  function _quoteDispatch(
    bytes calldata metadata,
    bytes calldata message
  ) internal view override returns (uint256) {
    bytes memory newMetadata = _overrideMsgValue(metadata);
    return innerHook.quoteDispatch(newMetadata, message) + value;
  }

  function _postDispatch(
    bytes calldata metadata,
    bytes calldata message
  ) internal override {
    bytes memory newMetadata = _overrideMsgValue(metadata);
    innerHook.postDispatch{ value: msg.value }(newMetadata, message);
  }
}
```

#### 2. IGP: maxDestinationValue Safety Cap

**File:** `solidity/contracts/hooks/igp/InterchainGasPaymaster.sol`

- Add `maxDestinationValue` mapping (uint32 domain => uint96 maxValue)
- Add `setMaxDestinationValues()` owner function
- Add `MaxDestinationValueSet` event
- **`maxDestinationValue == 0` means DISABLED** (not unlimited)
- Requesting value when disabled reverts with "IGP: exceeded max destination value"

```solidity
mapping(uint32 => uint96) public maxDestinationValue;

function quoteGasPayment(uint32 _dest, uint256 _gasLimit, uint256 _destValue)
    public view returns (uint256)
{
    // ... gas cost calculation ...
    if (_destinationValue > 0) {
        uint96 _maxValue = maxDestinationValue[_destinationDomain];
        require(_destinationValue <= _maxValue, "IGP: exceeded max destination value");
        _destinationGasCost += _destinationValue;
    }
    // ... return converted cost ...
}
```

#### 3. GasRouter: Remove Hardcoded Dust

**File:** `solidity/contracts/client/GasRouter.sol`

- Remove `destinationGasDust` immutable (was 100 gwei)
- Update `_GasRouter_hookMetadata()` to use `0` for msgValue
- Gas drop is now opt-in via ValueRequestHook, not default behavior

#### 4. VALUE_REQUEST Hook Type

**File:** `solidity/contracts/interfaces/hooks/IPostDispatchHook.sol`

- Add `VALUE_REQUEST` to `HookTypes` enum

#### 5. TokenRouter: Forward Value (Already in PR)

**File:** `solidity/contracts/token/libs/TokenRouter.sol`

- In `_handle()`, forward `msg.value` to the token recipient using `sendValue()`

### TypeScript SDK Changes

#### 1. Value-Aware Handle Estimation in Relayer

**File:** `typescript/sdk/src/core/HyperlaneRelayer.ts`

- Always simulate handle first (without value)
- If IGP present and value requested, simulate again with value
- If sendValue error, clear value (handle already verified to work)
- Uses `isSendValueError()` helper that checks error cause chain (SmartProvider wraps errors)
- Other errors propagate normally

```typescript
// Always simulate handle first
await this.core.estimateHandle(message);

// Extract and validate value from IGP if present
if (igp) {
  value = valueRequested?.args?.value;

  // If value requested, verify recipient can receive it
  if (value && BigNumber.from(value).gt(0)) {
    try {
      await this.core.estimateHandle(message, value);
    } catch (error: any) {
      // Check error and cause chain for sendValue revert
      if (this.isSendValueError(error)) {
        value = undefined; // Handle already verified, just clear value
      } else {
        throw error;
      }
    }
  }
}

// Helper method checks error.message, error.reason, and error.cause recursively
protected isSendValueError(error: any): boolean {
  const SEND_VALUE_ERROR = 'unable to send value, recipient may have reverted';
  if (error?.message?.includes(SEND_VALUE_ERROR)) return true;
  if (error?.reason?.includes(SEND_VALUE_ERROR)) return true;
  if (error?.cause) return this.isSendValueError(error.cause);
  return false;
}
```

#### 2. estimateHandle with Value in HyperlaneCore

**File:** `typescript/sdk/src/core/HyperlaneCore.ts`

- Add optional `value` parameter to `estimateHandle()`
- Simulates `recipient.handle{value}()` to test value delivery
- Throws on error (no longer swallows errors)

```typescript
async estimateHandle(
  message: DispatchedMessage,
  value?: BigNumberish,
): Promise<string> {
  return (
    await this.getRecipient(message).estimateGas.handle(
      message.parsed.origin,
      message.parsed.sender,
      message.parsed.body,
      { from: this.getAddresses(this.getDestination(message)).mailbox, value },
    )
  ).toString();
}
```

#### 2. estimateHandle with Value in HyperlaneCore

**File:** `typescript/sdk/src/core/HyperlaneCore.ts`

- Add optional `value` parameter to `estimateHandle()`
- Simulates `recipient.handle{value}()` to test value delivery

```typescript
async estimateHandle(
  message: DispatchedMessage,
  value?: BigNumberish,
): Promise<string> {
  try {
    return (
      await this.getRecipient(message).estimateGas.handle(
        message.parsed.origin,
        message.parsed.sender,
        message.parsed.body,
        { from: this.getAddresses(this.getDestination(message)).mailbox, value },
      )
    ).toString();
  } catch (error) {
    return '0';
  }
}
```

#### 3. ValueRequestHook SDK Support

**File:** `typescript/sdk/src/hook/types.ts`

- Add `VALUE_REQUEST` to `HookType` enum

**File:** `typescript/sdk/src/hook/EvmHookReader.ts`

- Add `deriveValueRequestHookConfig()` to read hook configuration

**File:** `typescript/sdk/src/hook/EvmHookModule.ts`

- Add deployment logic for `ValueRequestHook`

## Operator Workflow

### Enabling Gas Drop for a Warp Route

1. **Set maxDestinationValue on IGP** (relayer operator):

   ```solidity
   igp.setMaxDestinationValues([{remoteDomain: chainA, maxValue: 1 ether}])
   ```

2. **Calculate desired gas drop value** per destination:

   ```
   value = avgGasPerTx * gasPrice * numTransactions
   Example: 50,000 gas * 20 gwei * 5 txs = 0.005 ETH
   ```

3. **Deploy ValueRequestHook** for each destination:

   ```solidity
   new ValueRequestHook(defaultHook, 0.005 ether)
   ```

4. **Configure RoutingHook** to route to ValueRequestHooks:

   ```solidity
   routingHook.setHook(chainA, valueRequestHookA)
   routingHook.setHook(chainB, valueRequestHookB)
   ```

5. **Set warp route's hook** to RoutingHook:
   ```solidity
   warpRoute.setHook(routingHook)
   ```

### Updating Gas Drop Values

Deploy new ValueRequestHook with updated value, then update RoutingHook to point to new instance.

## Test Coverage

### Solidity Tests

**ValueRequestHook** (`solidity/test/hooks/ValueRequestHook.t.sol`):

- `test_hookType_returnsValueRequest`
- `test_quoteDispatch_addsValueToInnerQuote`
- `test_quoteDispatch_withZeroValue`
- `test_quoteDispatch_preservesGasLimit`
- `test_postDispatch_callsInnerHookWithModifiedMetadata`
- `test_postDispatch_forwardsFullMsgValue`
- `test_postDispatch_emitsValueRequestedFromIGP`
- Integration tests with IGP and RoutingHook

**IGP** (`solidity/test/igps/InterchainGasPaymaster.t.sol`):

- `testQuoteGasPayment_revertsWhenMaxValueZero`
- `testQuoteGasPayment_revertsWhenExceedsMax`
- `testQuoteGasPayment_succeedsWhenWithinMax`
- `testSetMaxDestinationValues`
- Existing ValueRequested event tests

### E2E Tests

**File:** `typescript/cli/src/tests/ethereum/warp/warp-send.e2e-test.ts`

- Test native value relaying through warp send with `--relay` flag

## Future Work

- **Rust relayer implementation** - Production relayer needs simulation-based retry
- **`valueRecipient` field** - Sending value to different address than message recipient
- **Dynamic value calculation** - Hook reading from IGP oracle at runtime
- **Per-destination configurable dust** - If keeping GasRouter approach

## Summary of Changes

| Component                      | Change                                          | Status |
| ------------------------------ | ----------------------------------------------- | ------ |
| `ValueRequestHook.sol`         | New composable hook contract                    | Done   |
| `ValueRequestHook.t.sol`       | Tests for new hook                              | Done   |
| `IPostDispatchHook.sol`        | Add `VALUE_REQUEST` hook type                   | Done   |
| `InterchainGasPaymaster.sol`   | `maxDestinationValue` with 0=disabled semantics | Done   |
| `InterchainGasPaymaster.t.sol` | Tests for maxDestinationValue                   | Done   |
| `GasRouter.sol`                | Remove `destinationGasDust` (use 0)             | Done   |
| `HyperlaneRelayer.ts`          | Extract value before estimateHandle, pass it    | Done   |
| `HyperlaneCore.ts`             | Add `value` param to `estimateHandle()`         | Done   |
| `EvmHookModule.ts`             | ValueRequestHook deployment support             | Done   |
| `EvmHookReader.ts`             | ValueRequestHook config reading                 | Done   |
| `hook/types.ts`                | Add VALUE_REQUEST hook type                     | Done   |
