## Review: feat(warp): Allow ERC20 IGP payments in `TokenRouter`

**Date:** 2026-01-15
**Reviewer:** Claude (automated)
**PR:** https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/7713
**Author:** larryob
**Base Branch:** token-igp
**Head Branch:** token-igp-warp

### Summary

| Severity      | Count |
| ------------- | ----- |
| Critical      | 0     |
| High          | 0     |
| Medium        | 1     |
| Low           | 3     |
| Informational | 4     |
| Gas           | 1     |

### Files Changed

| File                                                | Changes    |
| --------------------------------------------------- | ---------- |
| `solidity/contracts/token/libs/TokenRouter.sol`     | +181/-19   |
| `solidity/contracts/interfaces/ITokenBridge.sol`    | +2/-2      |
| `solidity/test/token/MovableCollateralRouter.t.sol` | +5/-3      |
| `solidity/test/token/TokenRouterIgp.t.sol`          | +462 (new) |

### Description

This PR adds ERC20 IGP payment support to TokenRouter, enabling warp route transfers to pay interchain gas fees using ERC20 tokens (specifically `token()`) instead of only native tokens.

**Key changes:**

- New `feeHook` storage slot and setter for configuring ERC20 IGP
- Modified `quoteTransferRemote` to return `token()` in Quote[0] when feeHook is configured
- Internal `_transferRemote` helper extracted from `transferRemote`
- Updated `_calculateFeesAndCharge` to handle ERC20 IGP payments with special handling for synthetic vs collateral routers
- New `_generateHookMetadata` function that includes fee token in metadata

---

### Critical

_No critical issues found_

---

### High

_No high severity issues found_

---

### Medium

**[M-1] Potential reentrancy via ERC-777 tokens** (TokenRouter.sol:232-236)

For synthetic routers (`token() == address(this)`), the code calls `safeTransferFrom` to pull hook fee tokens **before** `_transferFromSender(charge)`:

```solidity
if (_token != address(this)) {
    // Collateral router: add hook fee to charge
    charge += hookFee;
} else {
    // Synthetic router: pull hook fee tokens separately
    IERC20(_token).safeTransferFrom(
        msg.sender,
        address(this),
        hookFee
    );
}
// ...
_transferFromSender(charge);  // Called after safeTransferFrom
```

If the synthetic token implements ERC-777 hooks, a malicious actor could potentially reenter during `safeTransferFrom`. The state at that point has:

- Fee tokens transferred to router
- But `_transferFromSender` (which burns tokens) not yet called
- No reentrancy guard present

**Impact:** For standard ERC20 synthetic tokens (HypERC20), this is not exploitable since they don't have transfer hooks. However, if a custom synthetic token with ERC-777 hooks were used, reentrancy could occur.

**Recommendation:** Either:

1. Add a reentrancy guard to `transferRemote`/`_transferRemote`
2. Document that ERC-777 tokens are not supported as fee tokens
3. Move the approval and external call after `_transferFromSender`

---

### Low

**[L-1] Fee token is always `token()` - differs from PR description** (TokenRouter.sol:112, 449)

The PR description mentions:

> `bytes memory metadata = StandardHookMetadata.formatWithFeeToken(0, gasLimit, msg.sender, feeToken);`

However, the implementation always uses `token()` as the fee token when `feeHook` is set:

```solidity
address _feeToken = feeHook() != address(0) ? token() : address(0);
```

This means the fee token cannot be configured independently from the collateral/synthetic token. If a different fee token is desired, the current implementation doesn't support it.

**Recommendation:** Clarify if this is intentional or if separate fee token configuration should be added.

---

**[L-2] Dangling token approval on failed dispatch** (TokenRouter.sol:240)

The code approves the fee hook to pull tokens before dispatch:

```solidity
IERC20(_token).approve(_feeHook, hookFee);
```

If the subsequent `_Router_dispatch` fails (reverts), this approval remains. While the feeHook should be trusted, accumulated dangling approvals could be a concern.

**Recommendation:** Consider using `safeIncreaseAllowance` or resetting approval to 0 after dispatch completes.

---

**[L-3] No validation in `setFeeHook`** (TokenRouter.sol:355-357)

The setter doesn't validate that the address is a contract:

```solidity
function setFeeHook(address _feeHook) external onlyOwner {
  _setFeeHook(_feeHook);
}
```

Setting a non-contract address (other than address(0)) would cause `approve` calls to succeed silently but the hook wouldn't function.

**Recommendation:** Consider adding validation that `_feeHook` is either address(0) or a contract.

---

### Informational

**[I-1] Good use of StorageSlot pattern for upgrade safety**

The new storage variable uses the StorageSlot pattern consistent with existing code:

```solidity
bytes32 private constant FEE_HOOK_SLOT = keccak256("TokenRouter.feeHook");
```

This maintains storage layout compatibility with existing deployments.

---

**[I-2] Well-structured function overloads**

The PR adds convenience overloads for `_calculateFeesAndCharge`, `_emitAndDispatch`, and `_quoteGasPayment` that compute `feeHook()` internally. This maintains backward compatibility while allowing explicit fee hook passing for gas efficiency.

---

**[I-3] Clear separation of collateral vs synthetic router logic**

The code properly handles the two cases:

1. **Collateral routers** (`token() != address(this)`): Add hook fee to charge since `_transferFromSender` pulls tokens to the router
2. **Synthetic routers** (`token() == address(this)`): Pull hook fee separately since `_transferFromSender` burns tokens

The comments explain the reasoning well.

---

**[I-4] Test coverage**

The new `TokenRouterIgp.t.sol` test file provides coverage for:

- Setter access control
- Quote functionality for both native and ERC20 IGP
- Collateral router scenarios
- Synthetic router scenarios

---

### Gas Optimizations

**[G-1] Multiple `feeHook()` storage reads** (Various locations)

The `feeHook()` function is called multiple times in the same transaction flow:

- Once in `_transferRemote` (line 164)
- Once in `_emitAndDispatch` overload (line 306) - though not used in main path
- Multiple times in `quoteTransferRemote`

The main `_transferRemote` path caches `_feeHook` and passes it to subsequent functions, which is good. However, `quoteTransferRemote` reads `feeHook()` twice:

```solidity
address _feeToken = feeHook() != address(0) ? token() : address(0);  // First read
// ...
amount: _quoteGasPayment(_destination, _recipient, _amount)  // Calls feeHook() again internally
```

**Recommendation:** Cache `feeHook()` at the start of `quoteTransferRemote`.

---

### CI Status

Multiple e2e tests are failing. While some may be infrastructure-related, these should be investigated before merge:

- `coverage-run` - Failed after 6m50s
- `pnpm-test-run` - Failed after 2m43s
- Various CLI e2e tests

**Slither:** Passed

---

### Recommendations

1. **Address [M-1]** - Add documentation that ERC-777 tokens are not supported, or add a reentrancy guard to `_transferRemote`

2. **Clarify fee token design** - The implementation always uses `token()` as the fee token. If this is intentional, update the PR description. If separate fee token support is needed, additional storage/setters would be required.

3. **Investigate CI failures** - Several tests are failing and should be resolved before merge

4. **Consider [G-1]** - Cache `feeHook()` in `quoteTransferRemote` for gas efficiency

---

### Overall Assessment

This PR adds ERC20 IGP payment support in a clean, backward-compatible way. The implementation correctly handles the different router types (collateral vs synthetic) and maintains upgrade safety through the StorageSlot pattern. The code is well-documented and has good test coverage.

The main concern is the potential reentrancy issue [M-1] for synthetic routers with ERC-777 tokens, though this is unlikely to be exploited with standard HypERC20 tokens. The other findings are low severity and relate to defensive coding practices.

**Verdict:** Approve with minor changes - address [M-1] documentation and investigate CI failures.
