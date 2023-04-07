// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;
import {HyperlaneConnectionClient} from "../HyperlaneConnectionClient.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";

contract TestHyperlaneConnectionClient is HyperlaneConnectionClient {
    constructor() {
        _transferOwnership(msg.sender);
    }

    function initialize(address _mailbox) external initializer {
        __HyperlaneConnectionClient_initialize(_mailbox);
    }

    function localDomain() external view returns (uint32) {
        return mailbox.localDomain();
    }
}
