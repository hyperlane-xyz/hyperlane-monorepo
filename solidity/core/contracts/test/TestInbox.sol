// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../Inbox.sol";

contract TestInbox is Inbox {
    using TypedMemView for bytes;
    using TypedMemView for bytes29;
    using Message for bytes29;

    constructor(uint32 _localDomain) Inbox(_localDomain) {} // solhint-disable-line no-empty-blocks

    function setCheckpoint(bytes32 _root, uint256 _index) external {
        checkpoints[_root] = _index;
    }

    function testBranchRoot(
        bytes32 leaf,
        bytes32[32] calldata proof,
        uint256 index
    ) external pure returns (bytes32) {
        return MerkleLib.branchRoot(leaf, proof, index);
    }

    function testProcess(bytes calldata _message) external {
        _process(_message);
    }

    function setMessageStatus(bytes32 _leaf, MessageStatus status) external {
        messages[_leaf] = status;
    }

    function getRevertMsg(bytes memory _res)
        internal
        view
        returns (string memory)
    {
        bytes29 _view = _res.ref(0);

        // If the _res length is less than 68, then the transaction failed
        // silently (without a revert message)
        if (_view.len() < 68) return "Transaction reverted silently";

        // Remove the selector which is the first 4 bytes
        bytes memory _revertData = _view.slice(4, _res.length - 4, 0).clone();

        // All that remains is the revert string
        return abi.decode(_revertData, (string));
    }
}
