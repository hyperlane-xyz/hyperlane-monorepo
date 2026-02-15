// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {StaticAggregationIsmFactory} from "./StaticAggregationIsmFactory.sol";
import {StaticMessageIdMultisigIsmFactory} from "../multisig/StaticMultisigIsm.sol";
import {StaticMerkleRootMultisigIsmFactory} from "../multisig/StaticMultisigIsm.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

/**
 * @title StaticMultisigAggregationIsmFactory
 * @notice Factory that deploys an AggregationIsm containing both MessageIdMultisigIsm
 * and MerkleRootMultisigIsm with a threshold of 1 (either signature type accepted).
 *
 * This is the standard multisig ISM pattern used in Hyperlane core deployments,
 * packaged as a single factory call for convenience.
 *
 * @dev All deployed contracts use CREATE2 for deterministic addresses. Calling deploy()
 * with the same validators/threshold will return the existing contract addresses.
 *
 * @dev IMPORTANT: Validator addresses MUST be sorted in ascending order.
 * The underlying multisig ISM factories use CREATE2 with validators as part of the salt,
 * so different orderings produce different contract addresses.
 */
contract StaticMultisigAggregationIsmFactory is PackageVersioned {
    // ============ Immutables ============
    StaticAggregationIsmFactory public immutable aggregationIsmFactory;
    StaticMessageIdMultisigIsmFactory
        public immutable messageIdMultisigIsmFactory;
    StaticMerkleRootMultisigIsmFactory
        public immutable merkleRootMultisigIsmFactory;

    // ============ Events ============
    event MultisigAggregationIsmDeployed(
        address indexed aggregationIsm,
        address messageIdMultisigIsm,
        address merkleRootMultisigIsm,
        address[] validators,
        uint8 threshold
    );

    // ============ Constructor ============
    constructor(
        StaticAggregationIsmFactory _aggregationIsmFactory,
        StaticMessageIdMultisigIsmFactory _messageIdMultisigIsmFactory,
        StaticMerkleRootMultisigIsmFactory _merkleRootMultisigIsmFactory
    ) {
        aggregationIsmFactory = _aggregationIsmFactory;
        messageIdMultisigIsmFactory = _messageIdMultisigIsmFactory;
        merkleRootMultisigIsmFactory = _merkleRootMultisigIsmFactory;
    }

    // ============ External Functions ============

    /**
     * @notice Deploys an AggregationIsm containing MessageIdMultisigIsm and MerkleRootMultisigIsm
     * @dev Validators MUST be sorted in ascending order for deterministic addresses.
     * @param _validators Array of validator addresses (MUST be sorted ascending)
     * @param _threshold Number of validator signatures required
     * @return aggregationIsm The deployed AggregationIsm address
     */
    function deploy(
        address[] calldata _validators,
        uint8 _threshold
    ) external returns (address aggregationIsm) {
        // Deploy MessageIdMultisigIsm (reuses existing if same validators/threshold)
        address _messageIdIsm = messageIdMultisigIsmFactory.deploy(
            _validators,
            _threshold
        );

        // Deploy MerkleRootMultisigIsm (reuses existing if same validators/threshold)
        address _merkleRootIsm = merkleRootMultisigIsmFactory.deploy(
            _validators,
            _threshold
        );

        // Deploy AggregationIsm with threshold 1 (either MessageId OR MerkleRoot)
        address[] memory _modules = new address[](2);
        _modules[0] = _messageIdIsm;
        _modules[1] = _merkleRootIsm;
        aggregationIsm = aggregationIsmFactory.deploy(_modules, 1);

        emit MultisigAggregationIsmDeployed(
            aggregationIsm,
            _messageIdIsm,
            _merkleRootIsm,
            _validators,
            _threshold
        );
    }

    /**
     * @notice Computes the AggregationIsm address that would be deployed for given parameters
     * @dev Useful for predicting addresses before deployment or checking if already deployed.
     * @param _validators Array of validator addresses (MUST be sorted ascending)
     * @param _threshold Number of validator signatures required
     * @return aggregationIsm The AggregationIsm address
     */
    function getAddress(
        address[] calldata _validators,
        uint8 _threshold
    ) external view returns (address aggregationIsm) {
        // Compute MessageIdMultisigIsm address
        address _messageIdIsm = messageIdMultisigIsmFactory.getAddress(
            _validators,
            _threshold
        );

        // Compute MerkleRootMultisigIsm address
        address _merkleRootIsm = merkleRootMultisigIsmFactory.getAddress(
            _validators,
            _threshold
        );

        // Compute AggregationIsm address
        address[] memory _modules = new address[](2);
        _modules[0] = _messageIdIsm;
        _modules[1] = _merkleRootIsm;
        aggregationIsm = aggregationIsmFactory.getAddress(_modules, 1);
    }
}
