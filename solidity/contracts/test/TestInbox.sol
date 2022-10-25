// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "../Inbox.sol";

contract TestInbox is Inbox {
    using Message for bytes32;
    using TypeCasts for bytes32;

    constructor(uint32 _localDomain) Inbox(_localDomain) {} // solhint-disable-line no-empty-blocks

    function testBranchRoot(
        bytes32 leaf,
        bytes32[32] calldata proof,
        uint256 index
    ) external pure returns (bytes32) {
        return MerkleLib.branchRoot(leaf, proof, index);
    }

    function testProcess(bytes calldata _message, uint256 leafIndex) external {
        bytes32 _messageHash = keccak256(abi.encodePacked(_message, leafIndex));
        _process(_message, _messageHash);
    }

    function testHandle(
        uint32 origin,
        bytes32 sender,
        bytes32 recipient,
        bytes calldata body
    ) external {
        IMessageRecipient(recipient.bytes32ToAddress()).handle(
            origin,
            sender,
            body
        );
    }

    function setMessageStatus(bytes32 _leaf, MessageStatus status) external {
        messages[_leaf] = status;
    }

    function getRevertMsg(bytes calldata _res)
        internal
        pure
        returns (string memory)
    {
        // If the _res length is less than 68, then the transaction failed
        // silently (without a revert message)
        if (_res.length < 68) return "Transaction reverted silently";

        // Remove the selector (first 4 bytes) and decode revert string
        return abi.decode(_res[4:], (string));
    }
}
