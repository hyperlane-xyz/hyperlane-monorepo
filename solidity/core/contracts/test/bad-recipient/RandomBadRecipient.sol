// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../../../libs/TypeCasts.sol";

import {IInterchainGasPaymaster} from "../../../interfaces/IInterchainGasPaymaster.sol";
import {IMessageRecipient} from "../../../interfaces/IMessageRecipient.sol";
import {IOutbox} from "../../../interfaces/IOutbox.sol";

contract BadRandomRecipient is IMessageRecipient {
    using TypeCasts for address;

    event Handled(bytes32 blockHash);

    function dispatchToSelf(
        IOutbox _outbox,
        IInterchainGasPaymaster _paymaster,
        uint32 _destinationDomain,
        bytes calldata _messageBody
    ) external payable {
        uint256 _leafIndex = _outbox.dispatch(_destinationDomain, address(this).addressToBytes32(), _messageBody);
        _paymaster.payGasFor{value: msg.value}(_leafIndex);
    }

    function handle(
        uint32,
        bytes32,
        bytes calldata
    ) external override {
        bool isBlockHashEven = uint256(blockhash(block.number - 1)) % 2 == 0;
        require(isBlockHashEven, "block hash is odd");
        emit Handled(blockhash(block.number - 1));
    }
}
