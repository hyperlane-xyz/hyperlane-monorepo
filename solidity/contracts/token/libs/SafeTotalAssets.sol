// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @title SafeTotalAssets
/// @notice Duck-typed, non-reverting read of an ERC4626-style `totalAssets()`
/// from an address that may not implement it. Mirrors the `SafeERC20` pattern of
/// wrapping an external call, but reports capability instead of reverting so the
/// caller can treat a non-vault target as unsupported.
library SafeTotalAssets {
    /// @notice Attempts to read `totalAssets()` from `vault`.
    /// @dev Presence of the selector is duck typing, not proof of ERC4626
    /// semantics; callers relying on the value must define what it means for
    /// their target.
    /// @return supported True only if the call succeeded and returned exactly 32
    /// bytes. A revert or a malformed return yields false; a failed call is never
    /// reported as a numeric zero.
    /// @return assets The decoded value when `supported` is true, otherwise 0.
    function tryTotalAssets(
        address vault
    ) internal view returns (bool supported, uint256 assets) {
        (bool ok, bytes memory returnData) = vault.staticcall(
            abi.encodeCall(IERC4626.totalAssets, ())
        );
        if (!ok || returnData.length != 32) {
            return (false, 0);
        }
        return (true, abi.decode(returnData, (uint256)));
    }
}
