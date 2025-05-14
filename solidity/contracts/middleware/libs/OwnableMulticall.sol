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

    /// @dev The calls represented by the commitment can only be executed once per commitment,
    /// though you can submit the same commitment again after the calls have been executed.
    function revealAndExecute(
        CallLib.Call[] calldata calls,
        bytes32 salt
    ) external payable returns (bytes32 executedCommitment) {
        // If there is no active commitment, do nothing.
        if (commitment == bytes32(0)) return bytes32(0);

        bytes32 revealedHash = keccak256(abi.encode(calls, salt, this));
        require(commitment == revealedHash, "Invalid Reveal");

        // Delete the commitment (effects)
        executedCommitment = commitment;
        commitment = bytes32(0);

        // Execute the calls (interactions)
        CallLib.multicall(calls);
        return executedCommitment;
    }

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
