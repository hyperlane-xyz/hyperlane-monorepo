// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

contract TestDispatchNoReturnValue {
    event Dispatch(
        bytes32 indexed messageHash,
        uint256 indexed leafIndex,
        uint64 indexed destinationAndNonce,
        // Remove checkpointedRoot.
        bytes32 checkpointedRoot,
        bytes message
    );

    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes memory _messageBody
    ) external {
        // Ignore compiler
        _destinationDomain;
        _recipientAddress;

        bytes memory _message = _messageBody;
        bytes32 _messageHash = keccak256(_message);
        // Emit Dispatch event with message information
        emit Dispatch(_messageHash, 1, 1, _messageHash, _message);
    }
}
