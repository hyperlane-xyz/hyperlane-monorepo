// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInbox} from "../../interfaces/IInbox.sol";

/**
 * Intended for testing Inbox.sol, which requires its validator manager
 * to be a contract.
 */
contract TestValidatorManager {
    function cacheCheckpoint(
        IInbox _inbox,
        bytes32 _root,
        uint256 _index
    ) external {
        _inbox.cacheCheckpoint(_root, _index);
    }
}
