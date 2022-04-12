// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {IInbox} from "../../interfaces/IInbox.sol";

/**
 * Intended for testing Inbox.sol, which requires its validator manager
 * to be a contract.
 */
contract TestValidatorManager {
    function checkpoint(
        IInbox _inbox,
        bytes32 _root,
        uint256 _index
    ) external {
        _inbox.checkpoint(_root, _index);
    }
}
