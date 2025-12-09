// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {DomainRoutingIsmFactory} from "./DomainRoutingIsmFactory.sol";
import {StaticAggregationIsmFactory} from "../aggregation/StaticAggregationIsmFactory.sol";
import {StaticMessageIdMultisigIsmFactory} from "../multisig/StaticMultisigIsm.sol";
import {StaticMerkleRootMultisigIsmFactory} from "../multisig/StaticMultisigIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

/**
 * @title RoutingMultisigIsmFactory
 * @notice Factory that deploys the complete routing[agg(messageId, merkleRoot)] ISM structure
 * using existing audited ISM contracts. This factory simplifies deployment by:
 * 1. Deploying MessageId and MerkleRoot multisig ISMs for each domain
 * 2. Deploying an AggregationIsm (threshold 1) for each domain containing both multisig ISMs
 * 3. Deploying a DomainRoutingIsm that routes messages to the appropriate AggregationIsm
 *
 * This creates the same structure as the current core deployments but as a single factory call,
 * making ISM reads and updates much simpler (similar to Solana's approach).
 *
 * @dev This factory creates a fresh ISM tree on each deploy(). To update domains, deploy a new
 * routing ISM rather than modifying an existing one. The underlying DomainRoutingIsm supports
 * owner-controlled set() for adding domains, but this factory doesn't expose that pattern.
 *
 * @dev Gas considerations: Deploying for many domains in one transaction may hit block gas limits.
 * For large deployments (>10 domains), consider batching or deploying in multiple transactions.
 */
contract RoutingMultisigIsmFactory is PackageVersioned {
    // ============ Immutables ============
    DomainRoutingIsmFactory public immutable routingIsmFactory;
    StaticAggregationIsmFactory public immutable aggregationIsmFactory;
    StaticMessageIdMultisigIsmFactory
        public immutable messageIdMultisigIsmFactory;
    StaticMerkleRootMultisigIsmFactory
        public immutable merkleRootMultisigIsmFactory;

    // ============ Events ============
    event RoutingMultisigIsmDeployed(
        DomainRoutingIsm indexed routingIsm,
        uint32[] domains,
        address[] aggregationIsms
    );

    // ============ Constructor ============
    constructor(
        DomainRoutingIsmFactory _routingIsmFactory,
        StaticAggregationIsmFactory _aggregationIsmFactory,
        StaticMessageIdMultisigIsmFactory _messageIdMultisigIsmFactory,
        StaticMerkleRootMultisigIsmFactory _merkleRootMultisigIsmFactory
    ) {
        routingIsmFactory = _routingIsmFactory;
        aggregationIsmFactory = _aggregationIsmFactory;
        messageIdMultisigIsmFactory = _messageIdMultisigIsmFactory;
        merkleRootMultisigIsmFactory = _merkleRootMultisigIsmFactory;
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
            // Deploy MessageIdMultisigIsm for this domain
            address _messageIdIsm = messageIdMultisigIsmFactory.deploy(
                _validators[i],
                _thresholds[i]
            );

            // Deploy MerkleRootMultisigIsm for this domain
            address _merkleRootIsm = merkleRootMultisigIsmFactory.deploy(
                _validators[i],
                _thresholds[i]
            );

            // Deploy AggregationIsm with threshold 1 (either MessageId OR MerkleRoot)
            address[] memory _modules = new address[](2);
            _modules[0] = _messageIdIsm;
            _modules[1] = _merkleRootIsm;
            address _aggregationIsm = aggregationIsmFactory.deploy(_modules, 1);
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

        // Compute AggregationIsm addresses for each domain
        for (uint256 i = 0; i < _domainCount; ++i) {
            // Compute MessageIdMultisigIsm address
            address _messageIdIsm = messageIdMultisigIsmFactory.getAddress(
                _validators[i],
                _thresholds[i]
            );

            // Compute MerkleRootMultisigIsm address
            address _merkleRootIsm = merkleRootMultisigIsmFactory.getAddress(
                _validators[i],
                _thresholds[i]
            );

            // Compute AggregationIsm address
            address[] memory _modules = new address[](2);
            _modules[0] = _messageIdIsm;
            _modules[1] = _merkleRootIsm;
            aggregationIsms[i] = aggregationIsmFactory.getAddress(_modules, 1);
        }
    }
}
