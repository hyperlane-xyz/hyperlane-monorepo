// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {DefaultFallbackRoutingIsm} from "./DefaultFallbackRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

/**
 * @title AtomicInitDefaultFallbackRoutingIsm
 * @notice A DefaultFallbackRoutingIsm configured atomically during direct deployment.
 */
contract AtomicInitDefaultFallbackRoutingIsm is DefaultFallbackRoutingIsm {
    constructor(
        address _mailbox,
        address _owner,
        uint32[] memory _domains,
        IInterchainSecurityModule[] memory _modules
    ) DefaultFallbackRoutingIsm(_mailbox) {
        _initialize(_owner, _domains, _modules);
        _disableInitializers();
    }
}
