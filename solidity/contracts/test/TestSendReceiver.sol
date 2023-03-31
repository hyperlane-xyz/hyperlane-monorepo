// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../libs/TypeCasts.sol";

import {IInterchainGasPaymaster} from "../interfaces/IInterchainGasPaymaster.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";

contract TestSendReceiver is IMessageRecipient {
    using TypeCasts for address;

    uint256 public constant HANDLE_GAS_AMOUNT = 50_000;

    event Handled(bytes32 blockHash);

    function dispatchToSelf(
        IMailbox _mailbox,
        IInterchainGasPaymaster _paymaster,
        uint32 _destinationDomain,
        bytes calldata _messageBody
    ) external payable {
        bytes32 _messageId = _mailbox.dispatch(
            _destinationDomain,
            address(this).addressToBytes32(),
            _messageBody
        );
        uint256 _blockHashNum = uint256(previousBlockHash());
        uint256 _value = msg.value;
        if (_blockHashNum % 5 == 0) {
            // Pay in two separate calls, resulting in 2 distinct events
            uint256 _halfPayment = _value / 2;
            uint256 _halfGasAmount = HANDLE_GAS_AMOUNT / 2;
            _paymaster.payForGas{value: _halfPayment}(
                _messageId,
                _destinationDomain,
                _halfGasAmount,
                msg.sender
            );
            _paymaster.payForGas{value: _value - _halfPayment}(
                _messageId,
                _destinationDomain,
                HANDLE_GAS_AMOUNT - _halfGasAmount,
                msg.sender
            );
        } else {
            // Pay the entire msg.value in one call
            _paymaster.payForGas{value: _value}(
                _messageId,
                _destinationDomain,
                HANDLE_GAS_AMOUNT,
                msg.sender
            );
        }
    }

    function handle(
        uint32,
        bytes32,
        bytes calldata
    ) external override {
        bytes32 blockHash = previousBlockHash();
        bool isBlockHashEndIn0 = uint256(blockHash) % 16 == 0;
        require(!isBlockHashEndIn0, "block hash ends in 0");
        emit Handled(blockHash);
    }

    function previousBlockHash() internal view returns (bytes32) {
        return blockhash(block.number - 1);
    }
}
