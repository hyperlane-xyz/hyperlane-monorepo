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

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

// ============ Internal Imports ============
import {StandardHookMetadata} from "./StandardHookMetadata.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title AbstractPostDispatch
 * @notice Abstract post dispatch hook supporting the current global hook metadata variant.
 */
abstract contract AbstractPostDispatchHook is
    IPostDispatchHook,
    PackageVersioned
{
    using StandardHookMetadata for bytes;
    using Message for bytes;
    using Address for address payable;

    // ============ External functions ============

    /// @inheritdoc IPostDispatchHook
    function supportsMetadata(
        bytes calldata metadata
    ) public pure virtual override returns (bool) {
        return
            metadata.length == 0 ||
            metadata.variant() == StandardHookMetadata.VARIANT;
    }

    function _refund(
        bytes calldata metadata,
        bytes calldata message,
        uint256 amount
    ) internal {
        if (amount == 0) {
            return;
        }

        address refundAddress = metadata.refundAddress(message.senderAddress());
        require(
            refundAddress != address(0),
            "AbstractPostDispatchHook: no refund address"
        );
        payable(refundAddress).sendValue(amount);
    }

    /// @inheritdoc IPostDispatchHook
    function postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) external payable override {
        require(
            supportsMetadata(metadata),
            "AbstractPostDispatchHook: invalid metadata variant"
        );
        _postDispatch(metadata, message);
    }

    /// @inheritdoc IPostDispatchHook
    function quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) public view override returns (uint256) {
        require(
            supportsMetadata(metadata),
            "AbstractPostDispatchHook: invalid metadata variant"
        );
        return _quoteDispatch(metadata, message);
    }

    // ============ Internal functions ============

    /**
     * @notice Post dispatch hook implementation.
     * @param metadata The metadata of the message being dispatched.
     * @param message The message being dispatched.
     */
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal virtual;

    /**
     * @notice Quote dispatch hook implementation.
     * @param metadata The metadata of the message being dispatched.
     * @param message The message being dispatched.
     * @return The quote for the dispatch.
     */
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view virtual returns (uint256);
}
