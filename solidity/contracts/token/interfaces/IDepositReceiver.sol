// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.0;

interface IDepositReceiver {
    // @notice Deposit tokens from the bridge to the contract
    function depositFromBridge(address to, uint256 amount) external;
}
