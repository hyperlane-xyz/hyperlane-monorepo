// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../libs/TypeCasts.sol";

import {IInterchainGasPaymaster} from "../interfaces/IInterchainGasPaymaster.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";

import {MailboxClient} from "../client/MailboxClient.sol";

contract TestSendReceiver is IMessageRecipient {
    using TypeCasts for address;

    uint256 public constant HANDLE_GAS_AMOUNT = 50_000;
    uint256 public constant BODY_OFFSET = 77;

    event Handled(bytes32 blockHash);

    function dispatchToSelf(
        IMailbox _mailbox,
        uint32 _destinationDomain,
        bytes calldata _messageBody
    ) external payable {
        // TODO: handle topping up?
        _mailbox.dispatch{value: msg.value}(
            _destinationDomain,
            address(this).addressToBytes32(),
            _messageBody
        );
    }

    function dispatchToSelf(
        IMailbox _mailbox,
        uint32 _destinationDomain,
        bytes calldata _messageBody,
        IPostDispatchHook hook
    ) external payable {
        // TODO: handle topping up?
        _mailbox.dispatch{value: msg.value}(
            _destinationDomain,
            address(this).addressToBytes32(),
            _messageBody,
            bytes(""),
            hook
        );
    }

    function handle(
        uint32,
        bytes32,
        bytes calldata message
    ) external payable override {
        bytes32 blockHash = previousBlockHash();
        bytes memory body = message[BODY_OFFSET:];
        bytes memory hardcodedFail = hex"fa11ed";
        require(keccak256(body) != keccak256(hardcodedFail));
        emit Handled(blockHash);
    }

    function previousBlockHash() internal view returns (bytes32) {
        return blockhash(block.number - 1);
    }
}
