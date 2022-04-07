// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {Inbox} from "../Inbox.sol";

contract TestValidatorManager {
    function checkpoint(
        Inbox _inbox,
        bytes32 _root,
        uint256 _index
    ) external {
        _inbox.checkpoint(_root, _index);
    }
}
