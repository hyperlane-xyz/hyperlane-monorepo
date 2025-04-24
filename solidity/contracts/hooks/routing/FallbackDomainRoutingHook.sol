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
import {DomainRoutingHook} from "./DomainRoutingHook.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title FallbackDomainRoutingHook
 * @notice Delegates to a hook based on the destination domain of the message.
 * If no hook is configured for the destination domain, delegates to a fallback hook.
 */
contract FallbackDomainRoutingHook is DomainRoutingHook {
    using Message for bytes;

    IPostDispatchHook public immutable fallbackHook;

    constructor(
        address _mailbox,
        address _owner,
        address _fallback
    ) DomainRoutingHook(_mailbox, _owner) {
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
        IPostDispatchHook _hook = hooks[message.destination()];
        if (address(_hook) == address(0)) {
            _hook = fallbackHook;
        }
        return _hook;
    }
}
