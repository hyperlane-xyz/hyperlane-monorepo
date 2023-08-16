// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Mailbox} from "../Mailbox.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {MerkleLib} from "../libs/Merkle.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";

contract TestMailbox is Mailbox {
    using TypeCasts for bytes32;

    constructor(uint32 _localDomain, address _owner)
        Mailbox(_localDomain, _owner)
    {} // solhint-disable-line no-empty-blocks

    function testHandle(
        uint32 _origin,
        bytes32 _sender,
        bytes32 _recipient,
        bytes calldata _body
    ) external {
        IMessageRecipient(_recipient.bytes32ToAddress()).handle(
            _origin,
            _sender,
            _body
        );
    }

    function updateLatestDispatchedId(bytes32 _id) external {
        latestDispatchedId = _id;
    }
}
