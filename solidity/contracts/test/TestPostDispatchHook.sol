// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../libs/Message.sol";

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractPostDispatchHook} from "../hooks/libs/AbstractPostDispatchHook.sol";

contract TestPostDispatchHook is AbstractPostDispatchHook {
    using Message for bytes;

    // ============ Public Storage ============

    // test fees for quoteDispatch
    uint256 public fee = 0;

    // used to keep track of dispatched message
    mapping(bytes32 messageId => bool dispatched) public messageDispatched;

    // ============ External Functions ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.UNUSED);
    }

    function supportsMetadata(
        bytes calldata
    ) public pure override returns (bool) {
        return true;
    }

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    // ============ Internal functions ============
    function _postDispatch(
        bytes calldata,
        /*metadata*/ bytes calldata message
    ) internal override {
        messageDispatched[message.id()] = true;
    }

    function _quoteDispatch(
        bytes calldata /*metadata*/,
        bytes calldata /*message*/
    ) internal view override returns (uint256) {
        return fee;
    }
}
