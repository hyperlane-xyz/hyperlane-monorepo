# Gas Drop Feature Implementation Plan

## Overview

Enable gas drop (delivering native tokens to recipients on destination chains) as an opt-in, composable feature. This solves the UX problem of users not having gas to transact after bridging tokens to a new chain.

## Design Principles

1. **Composable** - Gas drop is a separate hook, not baked into warp routes
2. **Application-controlled** - Each app decides its own gas drop value
3. **Relayer-limited** - IGP's `maxDestinationValue` provides safety cap
4. **Simple** - ValueRequestHook is immutable, no admin functions

## Architecture

### Message Flow

```
Origin Chain:
1. User calls warpRoute.transferRemote()
2. Router dispatches with hook metadata (msgValue = 0 by default)
3. RoutingHook routes to ValueRequestHook for destination
4. ValueRequestHook injects msgValue into metadata
5. IGP.postDispatch() reads msgValue, emits ValueRequested(messageId, value)

Off-chain:
6. Relayer sees ValueRequested event
7. Relayer simulates process{value: X}()
8. If simulation succeeds, submit with value; otherwise submit without

Destination Chain:
9. Mailbox.process{value}() calls recipient.handle{value}()
10. TokenRouter._handle() forwards msg.value to token recipient
```

### Hook Tree (Example Setup)

```
WarpRoute
  └─→ hook = RoutingHook
              ├─→ chainA → ValueRequestHook(innerHook=defaultHook, value=0.001 ETH)
              ├─→ chainB → ValueRequestHook(innerHook=defaultHook, value=0.0001 ETH)
              └─→ chainC → defaultHook (no gas drop)
```

## Implementation

### Phase 1: Solidity Changes

#### 1.1 Remove `destinationGasDust` from GasRouter

**File:** `solidity/contracts/client/GasRouter.sol`

- Remove `uint256 public immutable destinationGasDust` (line 28)
- Remove `destinationGasDust = 100 gwei` from constructor (line 40)
- Update `_GasRouter_hookMetadata()` to use `0` for msgValue:

```solidity
function _GasRouter_hookMetadata(
  uint32 _destination
) internal view returns (bytes memory) {
  return
    StandardHookMetadata.format(
      0, // was: destinationGasDust
      destinationGas[_destination],
      msg.sender
    );
}
```

#### 1.2 Add ValueRequestHook Contract

**File:** `solidity/contracts/hooks/ValueRequestHook.sol` (new)

```solidity
// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import { AbstractPostDispatchHook } from './libs/AbstractPostDispatchHook.sol';
import { IPostDispatchHook } from '../interfaces/hooks/IPostDispatchHook.sol';
import { StandardHookMetadata } from './libs/StandardHookMetadata.sol';
import { Message } from '../libs/Message.sol';

/**
 * @title ValueRequestHook
 * @notice Injects a configured msgValue into hook metadata for gas drop functionality.
 * @dev Immutable configuration - deploy new instance to change value.
 */
contract ValueRequestHook is AbstractPostDispatchHook {
  using StandardHookMetadata for bytes;
  using Message for bytes;

  IPostDispatchHook public immutable innerHook;
  uint256 public immutable value;

  constructor(address _innerHook, uint256 _value) {
    innerHook = IPostDispatchHook(_innerHook);
    value = _value;
  }

  function hookType() external pure override returns (uint8) {
    return uint8(IPostDispatchHook.HookTypes.ID_AUTH_ISM); // TODO: add VALUE_REQUEST type
  }

  function _quoteDispatch(
    bytes calldata metadata,
    bytes calldata message
  ) internal view override returns (uint256) {
    bytes memory newMetadata = _overrideMsgValue(metadata, value);
    return innerHook.quoteDispatch(newMetadata, message) + value;
  }

  function _postDispatch(
    bytes calldata metadata,
    bytes calldata message
  ) internal override {
    bytes memory newMetadata = _overrideMsgValue(metadata, value);
    innerHook.postDispatch{ value: msg.value }(newMetadata, message);
  }

  function _overrideMsgValue(
    bytes calldata metadata,
    uint256 _value
  ) internal pure returns (bytes memory) {
    return
      StandardHookMetadata.formatMetadata(
        _value,
        metadata.gasLimit(0),
        metadata.refundAddress(address(0)),
        metadata.getCustomMetadata()
      );
  }
}
```

#### 1.3 Add ValueRequestHook Tests

**File:** `solidity/test/hooks/ValueRequestHook.t.sol` (new)

Test cases:

- `test_quoteDispatch_addsValueToInnerQuote`
- `test_postDispatch_passesModifiedMetadataToInnerHook`
- `test_postDispatch_emitsValueRequestedFromIGP`
- `test_zeroValue_passthroughBehavior`
- `test_integration_withRoutingHook`

#### 1.4 Keep Existing Changes (Already Implemented)

**IGP (`InterchainGasPaymaster.sol`):**

- `ValueRequested(messageId, value)` event ✓
- `maxDestinationValue` mapping ✓
- `setMaxDestinationValues()` setter ✓
- `quoteGasPayment(uint32, uint256, uint256)` 3-param version ✓

**TokenRouter (`token/libs/TokenRouter.sol`):**

- `msg.value` forwarding in `_handle()` ✓
- Uses `sendValue` (reverts on failure for simulation detection) ✓

### Phase 2: TypeScript SDK Changes

#### 2.1 Add Simulation-Based Retry to Relayer

**File:** `typescript/sdk/src/core/HyperlaneRelayer.ts`

```typescript
async relay(message: DispatchedMessage, dispatchTx: TransactionReceipt) {
  // ... existing metadata building ...

  let value: BigNumberish | undefined;
  // ... existing value extraction from ValueRequested event ...

  // Simulation-based retry for value delivery
  if (value && BigNumber.from(value).gt(0)) {
    try {
      await this.core.estimateProcess(message, metadata, value);
      this.logger.debug(`Simulation with value=${value} succeeded`);
    } catch (error) {
      this.logger.info(
        { error, value },
        `Value delivery would fail, relaying without value`
      );
      value = undefined;
    }
  }

  return this.core.deliver(message, metadata, value);
}
```

#### 2.2 Add `estimateProcess` to HyperlaneCore

**File:** `typescript/sdk/src/core/HyperlaneCore.ts`

```typescript
async estimateProcess(
  message: DispatchedMessage,
  ismMetadata: string,
  value?: BigNumberish,
): Promise<BigNumber> {
  const destinationChain = this.getDestination(message);
  const mailbox = this.getContracts(destinationChain).mailbox;
  return mailbox.estimateGas.process(ismMetadata, message.message, { value });
}
```

#### 2.3 Add ValueRequestHook Support (Optional - for deployment tooling)

**File:** `typescript/sdk/src/hook/types.ts`

```typescript
export const ValueRequestHookConfigSchema = z.object({
  type: z.literal(HookType.VALUE_REQUEST),
  innerHook: z.string(), // address
  value: z.string(), // wei amount
});
```

**File:** `typescript/sdk/src/hook/EvmHookReader.ts`

- Add `deriveValueRequestHookConfig()` method
- Read `innerHook` and `value` from contract

**File:** `typescript/sdk/src/hook/EvmHookModule.ts`

- Add deployment logic for `ValueRequestHook`

#### 2.4 Add SDK Helper for Calculating Gas Drop Value (Optional)

**File:** `typescript/sdk/src/hook/gasDropUtils.ts` (new)

```typescript
export async function suggestGasDropValue(
  multiProvider: MultiProvider,
  igp: InterchainGasPaymaster,
  destination: ChainName,
  options: { transactions: number; avgGasPerTx?: number },
): Promise<BigNumber> {
  const { transactions, avgGasPerTx = 50_000 } = options;
  const destDomain = multiProvider.getDomainId(destination);
  const { gasPrice } = await igp.getExchangeRateAndGasPrice(destDomain);
  return gasPrice.mul(avgGasPerTx).mul(transactions);
}
```

### Phase 3: Testing

#### 3.1 Unit Tests

- ValueRequestHook Solidity tests (Phase 1.3)
- TypeScript hook reader/module tests

#### 3.2 E2E Tests

- Gas drop with EOA recipient (should receive value)
- Gas drop with contract recipient that accepts ETH (should receive value)
- Gas drop with contract recipient that rejects ETH (relayer simulation detects, delivers without value)

## Operator Workflow

### Initial Setup

1. Calculate desired gas drop value for each destination chain:

   ```
   value = avgGasPerTx * gasPrice * numTransactions
   Example: 50,000 * 20 gwei * 5 = 0.005 ETH
   ```

   (SDK helper can assist with this calculation)

2. Deploy ValueRequestHook for each destination:

   ```
   ValueRequestHook(innerHook=defaultHook, value=0.005 ETH)
   ```

3. Configure RoutingHook to route to ValueRequestHooks:

   ```
   routingHook.setHook(chainA, valueRequestHookA)
   routingHook.setHook(chainB, valueRequestHookB)
   ```

4. Set warp route's hook to RoutingHook:
   ```
   warpRoute.setHook(routingHook)
   ```

### Updating Values

When gas prices change significantly:

1. Deploy new ValueRequestHook with updated value
2. Update RoutingHook to point to new instance
3. (Typically done alongside IGP gas oracle updates)

## Out of Scope (Future Work)

- **Rust relayer implementation** - Production relayer needs simulation-based retry
- **`valueRecipient` field** - Sending value to different address than message recipient
- **Dynamic value calculation** - Hook reading from IGP oracle at runtime

## Summary of Changes

| Component                    | Change                                        | Status           |
| ---------------------------- | --------------------------------------------- | ---------------- |
| `GasRouter.sol`              | Remove `destinationGasDust` immutable         | To do            |
| `ValueRequestHook.sol`       | New contract                                  | To do            |
| `ValueRequestHook.t.sol`     | New test file                                 | To do            |
| `InterchainGasPaymaster.sol` | `ValueRequested` event, `maxDestinationValue` | Done             |
| `TokenRouter.sol`            | `msg.value` forwarding in `_handle()`         | Done             |
| `HyperlaneRelayer.ts`        | Simulation-based retry                        | To do            |
| `HyperlaneCore.ts`           | Add `estimateProcess()`                       | To do            |
| Hook types/reader/module     | ValueRequestHook support                      | To do (optional) |
