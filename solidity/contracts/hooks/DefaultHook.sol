// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractPostDispatchHook} from "./libs/AbstractPostDispatchHook.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

/**
 * @title DefaultHook
 * @notice Delegates to whatever hook behavior is defined as the default on the mailbox.
 */
contract DefaultHook is AbstractPostDispatchHook, MailboxClient {
    constructor(address _mailbox) MailboxClient(_mailbox) {}

    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.Types.MAILBOX_DEFAULT_HOOK);
    }

    function _hook() public view returns (IPostDispatchHook) {
        return mailbox.defaultHook();
    }

    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view virtual override returns (uint256) {
        return _hook().quoteDispatch(metadata, message);
    }

    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal virtual override {
        _hook().postDispatch{value: msg.value}(metadata, message);
    }
}
