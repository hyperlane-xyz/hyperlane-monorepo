// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {Message} from "../libs/Message.sol";
import {IGPHookMetadata} from "../libs/hooks/IGPHookMetadata.sol";
import {IInterchainGasPaymaster} from "../interfaces/IInterchainGasPaymaster.sol";
import {AbstractHook} from "./AbstractHook.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

contract IGPHook is AbstractHook {
    using Address for address;
    using IGPHookMetadata for bytes;
    using Message for bytes;

    // ============ Constants ============

    address public immutable igp;

    constructor(address _mailbox, address _igp) AbstractHook(_mailbox) {
        igp = _igp;
    }

    // ============ External functions ============

    function _postDispatch(bytes calldata metadata, bytes calldata message)
        internal
        override
    {
        address refundAddress = metadata.refundAddress();
        if (!refundAddress.isContract())
            refundAddress = message.senderAddress();

        IInterchainGasPaymaster(igp).payForGas(
            message.id(),
            message.destination(),
            metadata.gasAmount(),
            refundAddress
        );
    }
}
