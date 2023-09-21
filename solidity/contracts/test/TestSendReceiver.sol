// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../libs/TypeCasts.sol";

import {IInterchainGasPaymaster} from "../interfaces/IInterchainGasPaymaster.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";

// import {IGPMetadata} from "../libs/hooks/IGPMetadata.sol";

contract TestSendReceiver is IMessageRecipient {
    using TypeCasts for address;

    uint256 public constant HANDLE_GAS_AMOUNT = 50_000;

    event Handled(bytes32 blockHash);

    // TODO: pay for gas in separate calls?
    function dispatchToSelf(
        IMailbox _mailbox,
        IInterchainGasPaymaster _paymaster,
        uint32 _destinationDomain,
        bytes calldata _messageBody
    ) external payable {
        // uint256 _blockHashNum = uint256(previousBlockHash());
        // bool separatePayments = (_blockHashNum % 5 == 0);
        // bytes memory metadata;
        // if (separatePayments) {
        //     // Pay in two separate calls, resulting in 2 distinct events
        //     metadata = IGPMetadata.formatMetadata(
        //         HANDLE_GAS_AMOUNT / 2,
        //         msg.sender
        //     );
        // } else {
        //     // Pay the entire msg.value in one call
        //     metadata = IGPMetadata.formatMetadata(
        //         HANDLE_GAS_AMOUNT,
        //         msg.sender
        //     );
        // }

        bytes32 recipient = address(this).addressToBytes32();
        _mailbox.dispatch{value: msg.value}(
            _destinationDomain,
            recipient,
            _messageBody
        );

        // if (separatePayments) {
        //     IInterchainGasPaymaster(address(_mailbox.defaultHook())).payForGas{
        //         value: quote
        //     }(
        //         _messageId,
        //         _destinationDomain,
        //         HANDLE_GAS_AMOUNT / 2,
        //         msg.sender
        //     );
        // }
    }

    function handle(
        uint32,
        bytes32,
        bytes calldata
    ) external payable override {
        bytes32 blockHash = previousBlockHash();
        bool isBlockHashEndIn0 = uint256(blockHash) % 16 == 0;
        require(!isBlockHashEndIn0, "block hash ends in 0");
        emit Handled(blockHash);
    }

    function previousBlockHash() internal view returns (bytes32) {
        return blockhash(block.number - 1);
    }
}
