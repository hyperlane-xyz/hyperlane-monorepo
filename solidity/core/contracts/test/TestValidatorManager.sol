// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInbox} from "../../interfaces/IInbox.sol";

/**
 * Intended for testing Inbox.sol, which requires its validator manager
 * to be a contract.
 */
contract TestValidatorManager {
    function process(
        IInbox _inbox,
        bytes32 _root,
        uint256 _index,
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _leafIndex
    ) external {
        _inbox.process(_root, _index, _message, _proof, _leafIndex);
    }
}
