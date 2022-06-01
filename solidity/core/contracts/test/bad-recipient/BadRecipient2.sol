// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

contract BadRecipient2 {
    function handle(uint32, bytes32) external pure {} // solhint-disable-line no-empty-blocks
}
