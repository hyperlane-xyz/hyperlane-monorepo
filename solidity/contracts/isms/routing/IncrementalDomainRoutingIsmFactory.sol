// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IncrementalDomainRoutingIsm} from "./IncrementalDomainRoutingIsm.sol";
import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {AbstractDomainRoutingIsmFactory} from "./DomainRoutingIsmFactory.sol";

/**
 * @title IncrementalDomainRoutingIsmFactory
 * @notice Factory for deploying IncrementalDomainRoutingIsm contracts as minimal proxies
 */
contract IncrementalDomainRoutingIsmFactory is AbstractDomainRoutingIsmFactory {
    // ============ Immutables ============
    address internal immutable _implementation;

    constructor() {
        _implementation = address(new IncrementalDomainRoutingIsm());
    }

    function implementation() public view override returns (address) {
        return _implementation;
    }
}
