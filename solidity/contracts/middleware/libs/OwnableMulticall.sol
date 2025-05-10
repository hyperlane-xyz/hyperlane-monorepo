// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {CallLib} from "./Call.sol";

/*
 * @title OwnableMulticall
 * @dev Permits immutable owner address to execute calls with value to other contracts.
 */
contract OwnableMulticall {
    /// @dev The owner will be the ICA Router that deployed this contract (via CREATE2).
    address public immutable owner;

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
        return CallLib.multicall(calls);
    }

    /// @notice The next commitment to execute.
    bytes32 public commitment;

    /// @notice Sets the commitment value that will be executed next
    /// @param _commitment The new commitment value to be set
    function setCommitment(bytes32 _commitment) external onlyOwner {
        commitment = _commitment;
    }

    /// @notice Deletes the commitment after it has been executed.
    function deleteCommitment() external onlyOwner {
        delete commitment;
    }

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
