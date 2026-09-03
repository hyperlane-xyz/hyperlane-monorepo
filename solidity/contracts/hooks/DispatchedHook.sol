// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {AbstractPostDispatchHook} from "./libs/AbstractPostDispatchHook.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {Message} from "../libs/Message.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title DispatchedHook
 * @notice Hook that updates a mapping to keep track of dispatched messages for storage proofs.
 */
contract DispatchedHook is AbstractPostDispatchHook, OwnableUpgradeable {
    using Message for bytes;

    uint256 public dispatchFee;
    mapping(uint256 messageNonce => bytes32 messageId) public dispatched;

    function initialize() external initializer {
        __Ownable_init();
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.DISPATCHED);
    }

    /**
     * @notice Sets the dispatch fee to the provided value.
     * @param _dispatchFee The new dispatch fee value.
     */
    function setDispatchFee(uint256 _dispatchFee) external onlyOwner {
        dispatchFee = _dispatchFee;
    }

    /**
     * @notice Sets the dispatched mapping to be used for storage proofs in the Telepathy / SP1 CCIP ISM.
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
        return dispatchFee;
    }
}
