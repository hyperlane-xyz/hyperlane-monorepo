// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/**
 * @title IMultiChainVaultHub
 * @notice Interface for the MultiChainVaultHub coordinating cross-chain liquidity and yield aggregation.
 */
interface IMultiChainVaultHub is IERC4626 {
    struct StrategyAllocation {
        uint32 domain;
        bytes32 adapter;
        uint256 targetWeightBps; // In basis points (e.g. 5000 = 50%)
        uint256 currentAllocatedAssets;
        uint256 lastReportedNav;
        uint256 lastReportTimestamp;
    }

    struct RebalanceOrder {
        uint32 sourceDomain;
        uint32 targetDomain;
        uint256 amount;
        uint256 minAmountOut;
        uint256 deadline;
    }

    event StrategyAdded(uint32 indexed domain, bytes32 indexed adapter, uint256 targetWeightBps);
    event StrategyUpdated(uint32 indexed domain, uint256 targetWeightBps);
    event StrategyRemoved(uint32 indexed domain);
    event RebalanceTriggered(uint256 totalAssetsRebalanced, uint256 timestamp);
    event StrategyReportReceived(uint32 indexed domain, uint256 nav, uint256 timestamp);
    event EmergencyPauseToggled(bool isPaused);
    event FeesAccrued(uint256 managementFeeShares, uint256 performanceFeeShares, uint256 timestamp);
    event DriftThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event FeeConfigUpdated(uint256 managementFeeBps, uint256 performanceFeeBps, address feeRecipient);

    function setStrategy(uint32 domain, bytes32 adapter, uint256 targetWeightBps) external;
    function removeStrategy(uint32 domain) external;
    function calculateDrift() external view returns (uint256 maxDriftBps, bool needsRebalance);
    function triggerRebalance(RebalanceOrder[] calldata orders, uint256 gasQuote) external payable;
    function reportStrategyNav(uint32 domain, uint256 currentNav) external;
    function totalPortfolioNav() external view returns (uint256);
    function getStrategy(uint32 domain) external view returns (StrategyAllocation memory);
    function getStrategyDomains() external view returns (uint32[] memory);
}
