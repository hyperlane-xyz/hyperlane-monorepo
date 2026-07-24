// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

/**
 * @title AtomicInitDomainRoutingIsm
 * @notice A DomainRoutingIsm configured atomically during direct deployment.
 * @dev Minimal proxy deployments should continue using DomainRoutingIsmFactory.
 */
contract AtomicInitDomainRoutingIsm is DomainRoutingIsm {
    constructor(
        address _owner,
        uint32[] memory _domains,
        IInterchainSecurityModule[] memory _modules
    ) {
        _initialize(_owner, _domains, _modules);
        _disableInitializers();
    }
}
