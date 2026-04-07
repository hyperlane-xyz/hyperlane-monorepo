// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IKatanaVaultRedeemer {
    /// @notice Redeems the specified Katana vault share amount to the helper's fixed beneficiary.
    /// @dev Intended to be called by an ICA poke. Reverts until the helper holds
    ///      at least `_shares`, so the same call can be retried until OFT funds arrive.
    function redeem(uint256 _shares) external returns (uint256 assetsOut);
}
