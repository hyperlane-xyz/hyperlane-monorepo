// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IBaseDelegator} from "./IBaseDelegator.sol";

interface INetworkRestakeDelegator is IBaseDelegator {
    error DuplicateRoleHolder();
    error ExceedsMaxNetworkLimit();
    error MissingRoleHolders();
    error ZeroAddressRoleHolder();

    /**
     * @notice Hints for a stake.
     * @param baseHints base hints
     * @param activeStakeHint hint for the active stake checkpoint
     * @param networkLimitHint hint for the subnetwork limit checkpoint
     * @param totalOperatorNetworkSharesHint hint for the total operator-subnetwork shares checkpoint
     * @param operatorNetworkSharesHint hint for the operator-subnetwork shares checkpoint
     */
    struct StakeHints {
        bytes baseHints;
        bytes activeStakeHint;
        bytes networkLimitHint;
        bytes totalOperatorNetworkSharesHint;
        bytes operatorNetworkSharesHint;
    }

    /**
     * @notice Initial parameters needed for a full restaking delegator deployment.
     * @param baseParams base parameters for delegators' deployment
     * @param networkLimitSetRoleHolders array of addresses of the initial NETWORK_LIMIT_SET_ROLE holders
     * @param operatorNetworkSharesSetRoleHolders array of addresses of the initial OPERATOR_NETWORK_SHARES_SET_ROLE holders
     */
    struct InitParams {
        IBaseDelegator.BaseParams baseParams;
        address[] networkLimitSetRoleHolders;
        address[] operatorNetworkSharesSetRoleHolders;
    }

    /**
     * @notice Emitted when a subnetwork's limit is set.
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param amount new subnetwork's limit (how much stake the vault curator is ready to give to the subnetwork)
     */
    event SetNetworkLimit(bytes32 indexed subnetwork, uint256 amount);

    /**
     * @notice Emitted when an operator's shares inside a subnetwork are set.
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @param shares new operator's shares inside the subnetwork (what percentage,
     *               which is equal to the shares divided by the total operators' shares,
     *               of the subnetwork's stake the vault curator is ready to give to the operator)
     */
    event SetOperatorNetworkShares(
        bytes32 indexed subnetwork,
        address indexed operator,
        uint256 shares
    );

    /**
     * @notice Get a subnetwork limit setter's role.
     * @return identifier of the subnetwork limit setter role
     */
    function NETWORK_LIMIT_SET_ROLE() external view returns (bytes32);

    /**
     * @notice Get an operator-subnetwork shares setter's role.
     * @return identifier of the operator-subnetwork shares setter role
     */
    function OPERATOR_NETWORK_SHARES_SET_ROLE() external view returns (bytes32);

    /**
     * @notice Get a subnetwork's limit at a given timestamp using a hint
     *         (how much stake the vault curator is ready to give to the subnetwork).
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param timestamp time point to get the subnetwork limit at
     * @param hint hint for checkpoint index
     * @return limit of the subnetwork at the given timestamp
     */
    function networkLimitAt(
        bytes32 subnetwork,
        uint48 timestamp,
        bytes memory hint
    ) external view returns (uint256);

    /**
     * @notice Get a subnetwork's limit (how much stake the vault curator is ready to give to the subnetwork).
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @return limit of the subnetwork
     */
    function networkLimit(bytes32 subnetwork) external view returns (uint256);

    /**
     * @notice Get a sum of operators' shares for a subnetwork at a given timestamp using a hint.
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param timestamp time point to get the total operators' shares at
     * @param hint hint for checkpoint index
     * @return total shares of the operators for the subnetwork at the given timestamp
     */
    function totalOperatorNetworkSharesAt(
        bytes32 subnetwork,
        uint48 timestamp,
        bytes memory hint
    ) external view returns (uint256);

    /**
     * @notice Get a sum of operators' shares for a subnetwork.
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @return total shares of the operators for the subnetwork
     */
    function totalOperatorNetworkShares(
        bytes32 subnetwork
    ) external view returns (uint256);

    /**
     * @notice Get an operator's shares for a subnetwork at a given timestamp using a hint (what percentage,
     *         which is equal to the shares divided by the total operators' shares,
     *         of the subnetwork's stake the vault curator is ready to give to the operator).
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @param timestamp time point to get the operator's shares at
     * @param hint hint for checkpoint index
     * @return shares of the operator for the subnetwork at the given timestamp
     */
    function operatorNetworkSharesAt(
        bytes32 subnetwork,
        address operator,
        uint48 timestamp,
        bytes memory hint
    ) external view returns (uint256);

    /**
     * @notice Get an operator's shares for a subnetwork (what percentage,
     *         which is equal to the shares divided by the total operators' shares,
     *         of the subnetwork's stake the vault curator is ready to give to the operator).
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @return shares of the operator for the subnetwork
     */
    function operatorNetworkShares(
        bytes32 subnetwork,
        address operator
    ) external view returns (uint256);

    /**
     * @notice Set a subnetwork's limit (how much stake the vault curator is ready to give to the subnetwork).
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param amount new limit of the subnetwork
     * @dev Only a NETWORK_LIMIT_SET_ROLE holder can call this function.
     */
    function setNetworkLimit(bytes32 subnetwork, uint256 amount) external;

    /**
     * @notice Set an operator's shares for a subnetwork (what percentage,
     *         which is equal to the shares divided by the total operators' shares,
     *         of the subnetwork's stake the vault curator is ready to give to the operator).
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @param shares new shares of the operator for the subnetwork
     * @dev Only an OPERATOR_NETWORK_SHARES_SET_ROLE holder can call this function.
     */
    function setOperatorNetworkShares(
        bytes32 subnetwork,
        address operator,
        uint256 shares
    ) external;
}
