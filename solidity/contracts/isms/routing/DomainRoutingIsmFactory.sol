// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {MinimalProxy} from "../../libs/MinimalProxy.sol";

/**
 * @title DomainRoutingIsmFactory
 */
contract DomainRoutingIsmFactory {
    // ============ Immutables ============
    address private immutable _implementation;

    /**
     * @notice Emitted when a routing module is deployed
     * @param module The deployed ISM
     */
    event ModuleDeployed(DomainRoutingIsm module);

    // ============ Constructor ============

    constructor() {
        _implementation = address(new DomainRoutingIsm());
    }

    // ============ External Functions ============

    /**
     * @notice Deploys and initializes a DomainRoutingIsm using a minimal proxy
     * @param _domains The origin domains
     * @param _modules The ISMs to use to verify messages
     */
    function deploy(
        uint32[] calldata _domains,
        IInterchainSecurityModule[] calldata _modules
    ) external returns (DomainRoutingIsm) {
        DomainRoutingIsm _ism = DomainRoutingIsm(
            MinimalProxy.create(_implementation)
        );
        emit ModuleDeployed(_ism);
        _ism.initialize(msg.sender, _domains, _modules);
        return _ism;
    }
}
