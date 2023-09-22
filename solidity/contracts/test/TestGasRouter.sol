// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "./TestRouter.sol";
import "../GasRouter.sol";

contract TestGasRouter is TestRouter, GasRouter {
    constructor(address _mailbox) TestRouter(_mailbox) {}

    function _metadata(uint32 _destination)
        internal
        view
        override(GasRouter, MailboxClient)
        returns (bytes memory)
    {
        return GasRouter._metadata(_destination);
    }
}
