// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../libs/Message.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";
import {AbstractCcipReadIsm} from "../isms/ccip-read/AbstractCcipReadIsm.sol";
import {ICcipReadIsm} from "../interfaces/isms/ICcipReadIsm.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IOptimismPortal} from "../interfaces/optimism/IOptimismPortal.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {MailboxClient} from "../client/MailboxClient.sol";

contract TestCcipReadIsm is AbstractCcipReadIsm, IMessageRecipient {
    uint8 public receivedMessages = 0;

    event ReceivedMessage(
        uint32 indexed origin,
        bytes32 indexed sender,
        uint256 indexed value,
        bytes message
    );

    constructor(address _mailbox) MailboxClient(_mailbox) {}

    function _offchainLookupCalldata(
        bytes calldata /*_message*/
    ) internal pure override returns (bytes memory) {
        return bytes("");
    }

    function verify(
        bytes calldata /*_metadata*/,
        bytes calldata /*_message*/
    ) external override returns (bool) {
        receivedMessages++;

        return true;
    }

    /**
     * @dev no-op handle
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _messageBody
    ) external payable {
        emit ReceivedMessage(_origin, _sender, msg.value, _messageBody);
    }
}
