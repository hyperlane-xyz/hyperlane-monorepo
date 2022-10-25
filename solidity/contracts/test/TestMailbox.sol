// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "../Mailbox.sol";

contract TestMailbox is Mailbox {
    constructor(uint32 _localDomain) Mailbox(_localDomain) {}

    function initialize(address _validatorManager) external initializer {
        __Mailbox_initialize(_validatorManager);
    }
}
