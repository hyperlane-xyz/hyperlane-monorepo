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

/**
 * @title FallbackDomainRecipientRoutingHook
 * @notice Delegates to a hook based on both the destination domain and recipient of the message.
 * If no hook is configured for the specific domain+recipient combination, delegates to a fallback hook.
 */
contract FallbackDomainRecipientRoutingHook is DomainRecipientRoutingHook {
    using Message for bytes;

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
        IPostDispatchHook _hook = hooks[message.destination()][
            message.recipient()
        ];
        if (address(_hook) == address(0)) {
            _hook = fallbackHook;
        }
        return _hook;
    }
}
