// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {DefaultFallbackRoutingIsm} from "./DefaultFallbackRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {MinimalProxy} from "../../libs/MinimalProxy.sol";

abstract contract AbstractDomainRoutingIsmFactory {
    /**
     * @notice Emitted when a routing module is deployed
     * @param module The deployed ISM
     */
    event ModuleDeployed(DomainRoutingIsm module);

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
            MinimalProxy.create(implementation())
        );
        emit ModuleDeployed(_ism);
        _ism.initialize(msg.sender, _domains, _modules);
        return _ism;
    }

    function implementation() public view virtual returns (address);
}

/**
 * @title DomainRoutingIsmFactory
 */
contract DomainRoutingIsmFactory is AbstractDomainRoutingIsmFactory {
    // ============ Immutables ============
    address internal immutable _implementation;

    constructor() {
        _implementation = address(new DomainRoutingIsm());
    }

    function implementation() public view override returns (address) {
        return _implementation;
    }
}

/**
 * @title DefaultFallbackRoutingIsmFactory
 */
contract DefaultFallbackRoutingIsmFactory is AbstractDomainRoutingIsmFactory {
    // ============ Immutables ============
    address internal immutable _implementation;

    constructor(address mailbox) {
        _implementation = address(new DefaultFallbackRoutingIsm(mailbox));
    }

    function implementation() public view override returns (address) {
        return _implementation;
    }
}
