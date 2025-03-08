// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.0;

interface DepositReceiver {
    // @notice Deposit tokens from the bridge to the contract
    function depositFromBridge(address to, address token, uint256 amount) external;
}
