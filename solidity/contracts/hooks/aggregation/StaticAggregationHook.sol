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

import {GlobalHookMetadata} from "../../libs/hooks/GlobalHookMetadata.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {MetaProxy} from "../../libs/MetaProxy.sol";

contract StaticAggregationHook is IPostDispatchHook {
    using GlobalHookMetadata for bytes;

    // ============ Constants ============

    // The variant of the metadata used in the hook
    uint8 public constant METADATA_VARIANT = 1;

    // ============ External functions ============

    // @inheritdoc IPostDispatchHook
    function supportsMetadata(bytes calldata metadata)
        public
        pure
        override
        returns (bool)
    {
        return metadata.length == 0 || metadata.variant() == METADATA_VARIANT;
    }

    // @inheritdoc IPostDispatchHook
    function postDispatch(bytes calldata metadata, bytes calldata message)
        external
        payable
        override
    {
        address[] memory _hooks = hooks(message);
        uint256 count = _hooks.length;
        for (uint256 i = 0; i < count; i++) {
            uint256 quote = IPostDispatchHook(_hooks[i]).quoteDispatch(
                metadata,
                message
            );

            IPostDispatchHook(_hooks[i]).postDispatch{value: quote}(
                metadata,
                message
            );
        }
    }

    // @inheritdoc IPostDispatchHook
    function quoteDispatch(bytes calldata metadata, bytes calldata message)
        external
        view
        override
        returns (uint256)
    {
        address[] memory _hooks = hooks(message);
        uint256 count = _hooks.length;
        uint256 total = 0;
        for (uint256 i = 0; i < count; i++) {
            total += IPostDispatchHook(_hooks[i]).quoteDispatch(
                metadata,
                message
            );
        }
        return total;
    }

    function hooks(bytes calldata) public pure returns (address[] memory) {
        return abi.decode(MetaProxy.metadata(), (address[]));
    }
}
