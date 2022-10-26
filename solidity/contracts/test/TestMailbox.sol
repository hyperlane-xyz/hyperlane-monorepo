// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";
import "../Mailbox.sol";

contract TestMailbox is Mailbox {
    using Message for bytes32;
    using TypeCasts for bytes32;

    constructor(uint32 _localDomain, uint32 _version)
        Mailbox(_localDomain, _version)
    {} // solhint-disable-line no-empty-blocks

    function proof() external view returns (bytes32[32] memory) {
        bytes32[32] memory _zeroes = MerkleLib.zeroHashes();
        uint256 _index = tree.count - 1;
        bytes32[32] memory _proof;

        for (uint256 i = 0; i < 32; i++) {
            uint256 _ithBit = (_index >> i) & 0x01;
            if (_ithBit == 1) {
                _proof[i] = tree.branch[i];
            } else {
                _proof[i] = _zeroes[i];
            }
        }
        return _proof;
    }

    function branch() external view returns (bytes32[32] memory) {
        return tree.branch;
    }

    function branchRoot(
        bytes32 _item,
        bytes32[32] memory _branch,
        uint256 _index
    ) external pure returns (bytes32) {
        return MerkleLib.branchRoot(_item, _branch, _index);
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

    function setMessageDelivered(bytes32 _id, bool _delivered) external {
        delivered[_id] = _delivered;
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
