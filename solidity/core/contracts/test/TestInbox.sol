// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "../Inbox.sol";

contract TestInbox is Inbox {
    using Message for bytes32;

    constructor(uint32 _localDomain) Inbox(_localDomain) {} // solhint-disable-line no-empty-blocks

    function testBranchRoot(MerkleLib.Proof calldata _proof)
        external
        pure
        returns (bytes32)
    {
        return MerkleLib.branchRoot(_proof);
    }

    function testProcess(
        Checkpoint calldata _checkpoint,
        MerkleLib.Proof calldata _proof,
        bytes calldata _message
    ) external {
        _process(_checkpoint, _proof, _message);
    }

    function setMessageStatus(
        uint32 _origin,
        bytes32 _leaf,
        MessageStatus status
    ) external {
        messages[_origin][_leaf] = status;
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
