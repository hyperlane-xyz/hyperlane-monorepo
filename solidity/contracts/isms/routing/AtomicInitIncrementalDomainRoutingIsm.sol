// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IncrementalDomainRoutingIsm} from "./IncrementalDomainRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

/**
 * @title AtomicInitIncrementalDomainRoutingIsm
 * @notice An IncrementalDomainRoutingIsm configured atomically during direct deployment.
 * @dev Minimal proxy deployments should continue using IncrementalDomainRoutingIsmFactory.
 */
contract AtomicInitIncrementalDomainRoutingIsm is IncrementalDomainRoutingIsm {
    constructor(
        address _owner,
        uint32[] memory _domains,
        IInterchainSecurityModule[] memory _modules
    ) {
        _initialize(_owner, _domains, _modules);
        _disableInitializers();
    }
}
