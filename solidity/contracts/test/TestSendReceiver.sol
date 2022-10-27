// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../libs/TypeCasts.sol";

import {IInterchainGasPaymaster} from "../../interfaces/IInterchainGasPaymaster.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";

contract TestSendReceiver is IMessageRecipient {
    using TypeCasts for address;

    event Handled(bytes32 blockHash);

    function dispatchToSelf(
        IMailbox _outbox,
        IInterchainGasPaymaster _paymaster,
        uint32 _destinationDomain,
        bytes calldata _messageBody
    ) external payable {
        bytes32 _messageId = _outbox.dispatch(
            _destinationDomain,
            address(this).addressToBytes32(),
            _messageBody
        );
        uint256 _blockHashNum = uint256(previousBlockHash());
        uint256 _value = msg.value;
        if (_blockHashNum % 5 == 0) {
            // Pay in two separate calls, resulting in 2 distinct events
            uint256 _half = _value / 2;
            _paymaster.payGasFor{value: _half}(
                address(_outbox),
                _messageId,
                _destinationDomain
            );
            _paymaster.payGasFor{value: _value - _half}(
                address(_outbox),
                _messageId,
                _destinationDomain
            );
        } else {
            // Pay the entire msg.value in one call
            _paymaster.payGasFor{value: _value}(
                address(_outbox),
                _messageId,
                _destinationDomain
            );
        }
    }

    function handle(
        uint32,
        bytes32,
        bytes calldata
    ) external override {
        bytes32 blockHash = previousBlockHash();
        bool isBlockHashEven = uint256(blockHash) % 2 == 0;
        require(isBlockHashEven, "block hash is odd");
        emit Handled(blockHash);
    }

    function previousBlockHash() internal view returns (bytes32) {
        return blockhash(block.number - 1);
    }
}
