// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Mailbox} from "../MailboxV2.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {MerkleLib} from "../libs/Merkle.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";

contract TestMailbox is Mailbox {
    using TypeCasts for bytes32;

    constructor(uint32 _localDomain) Mailbox(_localDomain) {} // solhint-disable-line no-empty-blocks

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
}
