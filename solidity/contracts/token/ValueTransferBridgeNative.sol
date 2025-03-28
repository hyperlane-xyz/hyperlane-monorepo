// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "./HypNative.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";
import {Quotes, IValueTransferBridge} from "../interfaces/IValueTransferBridge.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title Native/ERC20 tokens L2 to L1 value transfer abstraction
 * @author Substance Labs
 * @dev Derives from the Hyperlane native token router, but supports
 * transfer of ERC20 token value
 */
abstract contract ValueTransferBridgeNative is HypNative {
    /**
     * @dev see MailboxClient's initializer for other configurables
     */
    constructor(address _mailbox) HypNative(_mailbox) {
        _transferOwnership(_msgSender()); // TODO: remove
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual returns (Quotes[] memory quotes);
}
