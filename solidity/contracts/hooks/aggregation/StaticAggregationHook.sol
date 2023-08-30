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
import {MetaProxy} from "../../libs/MetaProxy.sol";

contract StaticAggregationHook is IPostDispatchHook {
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
