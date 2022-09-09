// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {IMessageRecipient} from "./IMessageRecipient.sol";
import {ISovereignZone} from "./ISovereignZone.sol";

interface ISovereignRecipient is IMessageRecipient {
    function zone() external view returns (ISovereignZone);
}
