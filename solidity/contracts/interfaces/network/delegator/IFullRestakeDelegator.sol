// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IBaseDelegator} from "./IBaseDelegator.sol";

interface IFullRestakeDelegator is IBaseDelegator {
    error DuplicateRoleHolder();
    error ExceedsMaxNetworkLimit();
    error MissingRoleHolders();
    error ZeroAddressRoleHolder();

    /**
     * @notice Hints for a stake.
     * @param baseHints base hints
     * @param activeStakeHint hint for the active stake checkpoint
     * @param networkLimitHint hint for the subnetwork limit checkpoint
     * @param operatorNetworkLimitHint hint for the operator-subnetwork limit checkpoint
     */
    struct StakeHints {
        bytes baseHints;
        bytes activeStakeHint;
        bytes networkLimitHint;
        bytes operatorNetworkLimitHint;
    }

    /**
     * @notice Initial parameters needed for a full restaking delegator deployment.
     * @param baseParams base parameters for delegators' deployment
     * @param networkLimitSetRoleHolders array of addresses of the initial NETWORK_LIMIT_SET_ROLE holders
     * @param operatorNetworkLimitSetRoleHolders array of addresses of the initial OPERATOR_NETWORK_LIMIT_SET_ROLE holders
     */
    struct InitParams {
        IBaseDelegator.BaseParams baseParams;
        address[] networkLimitSetRoleHolders;
        address[] operatorNetworkLimitSetRoleHolders;
    }

    /**
     * @notice Emitted when a subnetwork's limit is set.
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param amount new subnetwork's limit (how much stake the vault curator is ready to give to the subnetwork)
     */
    event SetNetworkLimit(bytes32 indexed subnetwork, uint256 amount);

    /**
     * @notice Emitted when an operator's limit for a subnetwork is set.
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @param amount new operator's limit for the subnetwork
     *               (how much stake the vault curator is ready to give to the operator for the subnetwork)
     */
    event SetOperatorNetworkLimit(
        bytes32 indexed subnetwork,
        address indexed operator,
        uint256 amount
    );

    /**
     * @notice Get a subnetwork limit setter's role.
     * @return identifier of the subnetwork limit setter role
     */
    function NETWORK_LIMIT_SET_ROLE() external view returns (bytes32);

    /**
     * @notice Get an operator-subnetwork limit setter's role.
     * @return identifier of the operator-subnetwork limit setter role
     */
    function OPERATOR_NETWORK_LIMIT_SET_ROLE() external view returns (bytes32);

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
     * @notice Get an operator's limit for a subnetwork at a given timestamp using a hint
     *         (how much stake the vault curator is ready to give to the operator for the subnetwork).
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @param timestamp time point to get the operator's limit for the subnetwork at
     * @param hint hint for checkpoint index
     * @return limit of the operator for the subnetwork at the given timestamp
     */
    function operatorNetworkLimitAt(
        bytes32 subnetwork,
        address operator,
        uint48 timestamp,
        bytes memory hint
    ) external view returns (uint256);

    /**
     * @notice Get an operator's limit for a subnetwork.
     *         (how much stake the vault curator is ready to give to the operator for the subnetwork)
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @return limit of the operator for the subnetwork
     */
    function operatorNetworkLimit(
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
     * @notice Set an operator's limit for a subnetwork.
     *         (how much stake the vault curator is ready to give to the operator for the subnetwork)
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @param amount new limit of the operator for the subnetwork
     * @dev Only an OPERATOR_NETWORK_LIMIT_SET_ROLE holder can call this function.
     */
    function setOperatorNetworkLimit(
        bytes32 subnetwork,
        address operator,
        uint256 amount
    ) external;
}
