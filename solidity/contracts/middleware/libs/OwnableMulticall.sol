// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {CallLib} from "./Call.sol";

/*
 * @title OwnableMulticall
 * @dev Permits immutable owner address to execute calls with value to other contracts.
 */
contract OwnableMulticall {
    using CallLib for CallLib.Call[];

    address public immutable owner;
    bytes32 public commitment;

    constructor(address _owner) {
        owner = _owner;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "!owner");
        _;
    }

    function multicall(
        CallLib.Call[] calldata calls
    ) external payable onlyOwner {
        return calls.multicall();
    }

    function commit(bytes32 _commitment) external payable onlyOwner {
        commitment = _commitment;
    }

    function reveal(
        CallLib.Call[] calldata calls,
        bytes32 salt
    ) external payable {
        require(commitment == calls.hash(salt), "!commitment");
        commitment = bytes32(0);
        calls.multicall();
    }

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
