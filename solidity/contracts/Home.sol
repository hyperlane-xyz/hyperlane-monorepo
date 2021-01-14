// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "./Common.sol";
import "./Merkle.sol";
import "./Queue.sol";

contract Home is MerkleTreeManager, QueueManager, Common {
    using QueueLib for QueueLib.Queue;
    using MerkleLib for MerkleLib.Tree;

    uint256 constant BOND_SIZE = 50 ether;

    event ImproperUpdate();

    constructor(uint32 _originSLIP44, address _updater)
        payable
        MerkleTreeManager()
        QueueManager()
        Common(_originSLIP44, _updater)
    {
        require(msg.value >= BOND_SIZE, "insufficient bond");
    }

    // TODO
    function fail() internal override {
        _setFailed();
        msg.sender.transfer(address(this).balance / 2);
    }

    function enqueue(
        uint32 destination,
        bytes32 recipient,
        bytes memory body
    ) external notFailed {
        bytes32 _digest =
            keccak256(
                abi.encodePacked(
                    originSLIP44,
                    bytes32(uint256(uint160(msg.sender))),
                    destination,
                    recipient,
                    body
                )
            );

        tree.insert(_digest);
        queue.enqueue(root());
    }

    function update(
        bytes32 _newRoot,
        bytes32 _oldRoot,
        bytes memory _signature
    ) external notFailed {
        if (improperUpdate(_newRoot, _oldRoot, _signature)) return;
        while (true) {
            bytes32 next = queue.dequeue();
            if (next == _newRoot) break;
        }
        emit Update(_oldRoot, _newRoot, _signature);
    }

    function improperUpdate(
        bytes32 _newRoot,
        bytes32 _oldRoot,
        bytes memory _signature
    ) public notFailed returns (bool) {
        require(Common.checkSig(_newRoot, _oldRoot, _signature), "bad sig");
        if (!queue.contains(_newRoot)) {
            fail();
            emit ImproperUpdate();
            return true;
        }
        return false;
    }
}
