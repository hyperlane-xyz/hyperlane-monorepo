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

import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {DomainRecipientRoutingHook} from "./DomainRecipientRoutingHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

/**
 * @title FallbackDomainRecipientRoutingHook
 * @notice Delegates to a hook based on both the destination domain and recipient of the message.
 * If no hook is configured for the specific domain+recipient combination, delegates to a fallback hook.
 */
contract FallbackDomainRecipientRoutingHook is DomainRecipientRoutingHook {
    using Message for bytes;
    using TypeCasts for bytes32;

    IPostDispatchHook public immutable fallbackHook;

    constructor(
        address _mailbox,
        address _owner,
        address _fallback
    ) DomainRecipientRoutingHook(_mailbox, _owner) {
        fallbackHook = IPostDispatchHook(_fallback);
    }

    // ============ External Functions ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.FALLBACK_ROUTING);
    }

    // ============ Internal Functions ============

    function _getConfiguredHook(
        bytes calldata message
    ) internal view override returns (IPostDispatchHook) {
        uint32 destination = message.destination();
        address recipient = message.recipient().bytes32ToAddress();

        IPostDispatchHook _hook = hooks[destination][recipient];
        if (address(_hook) == address(0)) {
            _hook = fallbackHook;
        }
        return _hook;
    }
}
