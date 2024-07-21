// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title TelepathyCcipReadHook
 * @notice Hook that updates the dispatched mapping to be used for storage proofs in the Telepathy CCIP ISM.
 */
contract TelepathyCcipReadHook is AbstractPostDispatchHook {
    using Message for bytes;

    mapping(uint256 messageNonce => bytes32 messageId) public dispatched;

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.Types.CCIP_READ);
    }

    /**
     * @notice Sets the dispatched mapping to be used for storage proofs in the Telepathy CCIP ISM.
     * @param message Message to be dispatched
     */
    function _postDispatch(
        bytes calldata,
        bytes calldata message
    ) internal virtual override {
        dispatched[message.nonce()] = message.id();
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata,
        bytes calldata
    ) internal view virtual override returns (uint256) {
        return 0;
    }
}
