// SPDX-License-Identifier: MIT
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

import {Message} from "../libs/Message.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {Indexed} from "../libs/Indexed.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractPostDispatchHook} from "./libs/AbstractPostDispatchHook.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";

contract LayerZeroHook is AbstractPostDispatchHook, MailboxClient, Indexed {
    constructor(address _mailbox) MailboxClient(_mailbox) {}

    // ============ External Functions ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.LAYER_ZERO);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal virtual override {}

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view virtual override returns (uint256) {}
}
