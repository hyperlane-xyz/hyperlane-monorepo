// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title IYieldStrategyAdapter
 * @notice Interface for spoke chain yield strategy adapters interfacing with local ERC-4626 protocols.
 */
interface IYieldStrategyAdapter {
    event DepositExecuted(uint256 amount, uint256 sharesMinted);
    event WithdrawExecuted(uint256 sharesBurned, uint256 assetsReceived);
    event NavSynchronized(uint256 currentNav, uint256 timestamp);
    event EmergencyUnwound(uint256 assetsRecovered);

    function depositToYieldStrategy(uint256 amount, uint256 minSharesOut) external returns (uint256 shares);
    function withdrawFromYieldStrategy(uint256 shares, uint256 minAssetsOut) external returns (uint256 assets);
    function getStrategyNav() external view returns (uint256);
    function syncNavToHub(uint256 gasPayment) external payable;
    function emergencyUnwind(uint256 minAssetsOut) external;
}
