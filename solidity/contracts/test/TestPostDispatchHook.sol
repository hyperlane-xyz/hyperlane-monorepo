// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {GlobalHookMetadata} from "../libs/hooks/GlobalHookMetadata.sol";

contract TestPostDispatchHook is IPostDispatchHook {
    using GlobalHookMetadata for bytes;

    // ============ Constants ============

    // The variant of the metadata used in the hook
    uint8 public constant METADATA_VARIANT = 1;

    // ============ Public Storage ============

    // test fees for quoteDispatch
    uint256 public fee = 25000;

    // @inheritdoc IPostDispatchHook
    function supportsMetadata(bytes calldata metadata)
        public
        pure
        override
        returns (bool)
    {
        return metadata.length == 0 || metadata.variant() == METADATA_VARIANT;
    }

    function postDispatch(
        bytes calldata,
        /*metadata*/
        bytes calldata /*message*/
    ) external payable {
        // test - empty
    }

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function quoteDispatch(
        bytes calldata,
        /*metadata*/
        bytes calldata /*message*/
    ) external view override returns (uint256) {
        return fee;
    }
}
