// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../libs/Message.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";
import {AbstractCcipReadIsm} from "../isms/ccip-read/AbstractCcipReadIsm.sol";
import {ICcipReadIsm} from "../interfaces/isms/ICcipReadIsm.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {IOptimismPortal} from "../interfaces/optimism/IOptimismPortal.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";

contract TestCcipReadIsm is
    AbstractCcipReadIsm,
    IMessageRecipient,
    ISpecifiesInterchainSecurityModule
{
    uint8 public receivedMessages = 0;
    IMailbox public mailbox;

    event ReceivedMessage(
        uint32 indexed origin,
        bytes32 indexed sender,
        uint256 indexed value,
        bytes message
    );

    constructor(address _mailbox) {
        mailbox = IMailbox(_mailbox);
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        string[] memory urls;
        revert OffchainLookup(
            address(this),
            urls,
            bytes(""),
            TestCcipReadIsm.process.selector,
            _message
        );
    }

    /// @dev called by the relayer when the off-chain data is ready
    function process(
        bytes calldata _metadata,
        bytes calldata _message
    ) external {
        mailbox.process(_metadata, _message);
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata _message
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

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }
}
