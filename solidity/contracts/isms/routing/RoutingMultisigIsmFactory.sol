// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {DomainRoutingIsmFactory} from "./DomainRoutingIsmFactory.sol";
import {StaticMultisigAggregationIsmFactory} from "../aggregation/StaticMultisigAggregationIsmFactory.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

/**
 * @notice Configuration for a single domain's multisig ISM
 * @param domain The origin domain ID
 * @param validators Array of validator addresses (MUST be sorted ascending)
 * @param threshold Number of validator signatures required
 */
struct DomainConfig {
    uint32 domain;
    address[] validators;
    uint8 threshold;
}

/**
 * @title RoutingMultisigIsmFactory
 * @notice Factory that deploys the complete routing[agg(messageId, merkleRoot)] ISM structure.
 *
 * This factory orchestrates:
 * 1. Deploying an AggregationIsm (containing MessageId + MerkleRoot multisig ISMs) for each domain
 * 2. Deploying a DomainRoutingIsm that routes messages to the appropriate AggregationIsm
 *
 * For incremental domain additions, use deployAndSet() to batch-add domains to an existing
 * routing ISM, or use StaticMultisigAggregationIsmFactory directly for single domains.
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
        DomainConfig[] configs
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
     * @dev IMPORTANT: Validator addresses in each config MUST be sorted in ascending order.
     * The underlying multisig ISM factories use CREATE2 with validators as part of the salt,
     * so different orderings produce different contract addresses.
     * @param _owner The owner of the routing ISM (can call set() to add/update domains later)
     * @param _configs Array of domain configurations
     * @return routingIsm The deployed DomainRoutingIsm that routes to AggregationIsms
     */
    function deploy(
        address _owner,
        DomainConfig[] calldata _configs
    ) external returns (DomainRoutingIsm routingIsm) {
        uint256 _configCount = _configs.length;
        uint32[] memory _domains = new uint32[](_configCount);
        IInterchainSecurityModule[]
            memory _aggregationIsms = new IInterchainSecurityModule[](
                _configCount
            );

        // Deploy AggregationIsm for each domain
        for (uint256 i = 0; i < _configCount; ++i) {
            _domains[i] = _configs[i].domain;
            _aggregationIsms[i] = IInterchainSecurityModule(
                multisigAggregationIsmFactory.deploy(
                    _configs[i].validators,
                    _configs[i].threshold
                )
            );
        }

        // Deploy DomainRoutingIsm that routes each domain to its AggregationIsm
        routingIsm = routingIsmFactory.deploy(
            _owner,
            _domains,
            _aggregationIsms
        );

        emit RoutingMultisigIsmDeployed(routingIsm, _configs);
    }

    /**
     * @notice Deploys aggregation ISMs and sets them on an existing routing ISM
     * @dev Caller must be the owner of the routing ISM. This enables atomic batch
     * updates for adding multiple domains to an existing routing ISM.
     * @dev IMPORTANT: Validator addresses in each config MUST be sorted in ascending order.
     * @param _routingIsm The existing routing ISM to update
     * @param _configs Array of domain configurations
     */
    function deployAndSet(
        DomainRoutingIsm _routingIsm,
        DomainConfig[] calldata _configs
    ) external {
        uint256 _configCount = _configs.length;

        for (uint256 i = 0; i < _configCount; ++i) {
            _routingIsm.set(
                _configs[i].domain,
                IInterchainSecurityModule(
                    multisigAggregationIsmFactory.deploy(
                        _configs[i].validators,
                        _configs[i].threshold
                    )
                )
            );
        }
    }

    /**
     * @notice Computes the addresses of the AggregationIsms that would be deployed
     * @dev The DomainRoutingIsm address cannot be computed deterministically
     * as it uses MinimalProxy.create() which generates non-deterministic addresses.
     * Domain values don't affect ISM addresses (only validators and thresholds
     * determine the CREATE2 addresses).
     * @param _configs Array of domain configurations
     * @return aggregationIsms Array of AggregationIsm addresses (one per domain)
     */
    function getAggregationIsmAddresses(
        DomainConfig[] calldata _configs
    ) external view returns (address[] memory aggregationIsms) {
        uint256 _configCount = _configs.length;
        aggregationIsms = new address[](_configCount);

        for (uint256 i = 0; i < _configCount; ++i) {
            aggregationIsms[i] = multisigAggregationIsmFactory.getAddress(
                _configs[i].validators,
                _configs[i].threshold
            );
        }
    }
}
