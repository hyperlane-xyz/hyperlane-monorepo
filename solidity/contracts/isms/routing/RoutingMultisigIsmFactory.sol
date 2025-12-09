// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {DomainRoutingIsmFactory} from "./DomainRoutingIsmFactory.sol";
import {StaticMultisigAggregationIsmFactory} from "../aggregation/StaticMultisigAggregationIsmFactory.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

/**
 * @title RoutingMultisigIsmFactory
 * @notice Factory that deploys the complete routing[agg(messageId, merkleRoot)] ISM structure.
 *
 * This factory orchestrates:
 * 1. Deploying an AggregationIsm (containing MessageId + MerkleRoot multisig ISMs) for each domain
 * 2. Deploying a DomainRoutingIsm that routes messages to the appropriate AggregationIsm
 *
 * For incremental domain additions, use StaticMultisigAggregationIsmFactory directly to deploy
 * new aggregation ISMs, then call routingIsm.set(domain, newAggIsm) on the existing routing ISM.
 *
 * @dev Gas considerations: Deploying for many domains in one transaction may hit block gas limits.
 * For large deployments (>10 domains), consider batching or deploying in multiple transactions.
 */
contract RoutingMultisigIsmFactory is PackageVersioned {
    // ============ Immutables ============
    DomainRoutingIsmFactory public immutable routingIsmFactory;
    StaticMultisigAggregationIsmFactory
        public immutable multisigAggregationIsmFactory;

    // ============ Events ============
    event RoutingMultisigIsmDeployed(
        DomainRoutingIsm indexed routingIsm,
        uint32[] domains,
        address[] aggregationIsms
    );

    // ============ Constructor ============
    constructor(
        DomainRoutingIsmFactory _routingIsmFactory,
        StaticMultisigAggregationIsmFactory _multisigAggregationIsmFactory
    ) {
        routingIsmFactory = _routingIsmFactory;
        multisigAggregationIsmFactory = _multisigAggregationIsmFactory;
    }

    // ============ External Functions ============

    /**
     * @notice Deploys the complete routing[agg(messageId, merkleRoot)] ISM structure
     * @dev IMPORTANT: Validator addresses MUST be sorted in ascending order for each domain.
     * The underlying multisig ISM factories use CREATE2 with validators as part of the salt,
     * so different orderings produce different contract addresses. Sorting ensures deterministic
     * addresses and enables contract reuse across deployments with the same validator set.
     * @param _owner The owner of the routing ISM (can call set() to add/update domains later)
     * @param _domains Array of origin domains to configure
     * @param _validators Array of validator arrays (one per domain, each MUST be sorted ascending)
     * @param _thresholds Array of thresholds (one per domain)
     * @return routingIsm The deployed DomainRoutingIsm that routes to AggregationIsms
     * @return aggregationIsmAddresses Array of deployed AggregationIsm addresses (one per domain)
     */
    function deploy(
        address _owner,
        uint32[] calldata _domains,
        address[][] calldata _validators,
        uint8[] calldata _thresholds
    )
        external
        returns (
            DomainRoutingIsm routingIsm,
            address[] memory aggregationIsmAddresses
        )
    {
        require(
            _domains.length == _validators.length &&
                _domains.length == _thresholds.length,
            "length mismatch"
        );

        uint256 _domainCount = _domains.length;
        IInterchainSecurityModule[]
            memory _aggregationIsms = new IInterchainSecurityModule[](
                _domainCount
            );
        aggregationIsmAddresses = new address[](_domainCount);

        // Deploy AggregationIsm for each domain
        for (uint256 i = 0; i < _domainCount; ++i) {
            address _aggregationIsm = multisigAggregationIsmFactory.deploy(
                _validators[i],
                _thresholds[i]
            );
            _aggregationIsms[i] = IInterchainSecurityModule(_aggregationIsm);
            aggregationIsmAddresses[i] = _aggregationIsm;
        }

        // Deploy DomainRoutingIsm that routes each domain to its AggregationIsm
        routingIsm = routingIsmFactory.deploy(
            _owner,
            _domains,
            _aggregationIsms
        );

        emit RoutingMultisigIsmDeployed(
            routingIsm,
            _domains,
            aggregationIsmAddresses
        );
    }

    /**
     * @notice Computes the addresses of the AggregationIsms that would be deployed
     * @dev Note: The DomainRoutingIsm address cannot be computed deterministically
     * as it uses MinimalProxy.create() which generates non-deterministic addresses.
     * The _domains parameter is included for API consistency with deploy() and to
     * validate array lengths match, but domain values don't affect ISM addresses
     * (only validators and thresholds determine the CREATE2 addresses).
     * @param _domains Array of origin domains (used for length validation only)
     * @param _validators Array of validator arrays (one per domain, MUST be sorted ascending)
     * @param _thresholds Array of thresholds (one per domain)
     * @return aggregationIsms Array of AggregationIsm addresses (one per domain)
     */
    function getAggregationIsmAddresses(
        uint32[] calldata _domains,
        address[][] calldata _validators,
        uint8[] calldata _thresholds
    ) external view returns (address[] memory aggregationIsms) {
        require(
            _domains.length == _validators.length &&
                _domains.length == _thresholds.length,
            "length mismatch"
        );

        uint256 _domainCount = _domains.length;
        aggregationIsms = new address[](_domainCount);

        for (uint256 i = 0; i < _domainCount; ++i) {
            aggregationIsms[i] = multisigAggregationIsmFactory.getAddress(
                _validators[i],
                _thresholds[i]
            );
        }
    }
}
