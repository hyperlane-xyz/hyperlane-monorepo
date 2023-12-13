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

    event Handled(uint256 randao);

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

    // for testing random failure of handle call for the agents
    // if randao ends in 0, fail
    function handle(uint32, bytes32, bytes calldata) external payable override {
        uint256 randao = block.prevrandao;
        bool doesRandaoEndIn0 = randao % 16 == 0;
        require(!doesRandaoEndIn0, "randao ends in 0");
        emit Handled(randao);
    }
}
