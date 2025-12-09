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
 */
contract RoutingMultisigIsmFactory is PackageVersioned {
    // ============ Immutables ============
    DomainRoutingIsmFactory public immutable routingIsmFactory;
    StaticAggregationIsmFactory public immutable aggregationIsmFactory;
    StaticMessageIdMultisigIsmFactory public immutable messageIdMultisigIsmFactory;
    StaticMerkleRootMultisigIsmFactory public immutable merkleRootMultisigIsmFactory;

    // ============ Events ============
    event RoutingMultisigIsmDeployed(
        DomainRoutingIsm indexed routingIsm,
        uint32[] domains
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
     * @dev For contract reuse, consider sorting validator addresses before calling
     * @param _owner The owner of the routing ISM
     * @param _domains Array of origin domains to configure
     * @param _validators Array of validator arrays (one per domain)
     * @param _thresholds Array of thresholds (one per domain)
     * @return routingIsm The deployed DomainRoutingIsm that routes to AggregationIsms
     */
    function deploy(
        address _owner,
        uint32[] calldata _domains,
        address[][] calldata _validators,
        uint8[] calldata _thresholds
    ) external returns (DomainRoutingIsm routingIsm) {
        require(
            _domains.length == _validators.length &&
                _domains.length == _thresholds.length,
            "length mismatch"
        );

        uint256 _domainCount = _domains.length;
        IInterchainSecurityModule[] memory _aggregationIsms = new IInterchainSecurityModule[](
            _domainCount
        );

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
            _aggregationIsms[i] = IInterchainSecurityModule(
                aggregationIsmFactory.deploy(_modules, 1)
            );
        }

        // Deploy DomainRoutingIsm that routes each domain to its AggregationIsm
        routingIsm = routingIsmFactory.deploy(
            _owner,
            _domains,
            _aggregationIsms
        );

        emit RoutingMultisigIsmDeployed(routingIsm, _domains);
    }

    /**
     * @notice Computes the addresses of the AggregationIsms that would be deployed
     * @dev Note: The DomainRoutingIsm address cannot be computed deterministically
     * as it uses MinimalProxy.create() which generates non-deterministic addresses
     * @param _domains Array of origin domains to configure
     * @param _validators Array of validator arrays (one per domain)
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
            aggregationIsms[i] = aggregationIsmFactory.getAddress(
                _modules,
                1
            );
        }
    }
}
