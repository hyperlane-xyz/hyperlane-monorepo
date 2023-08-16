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

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {MetaProxy} from "../libs/MetaProxy.sol";

contract AggregationHook is IPostDispatchHook {
    event SuccessfulAggregationHookCall(address indexed hook);
    event ErroneousAggregationHookCall(address indexed hook);

    function postDispatch(bytes calldata metadata, bytes calldata message)
        external
        payable
        override
    {
        address[] memory _hooks = hooks(message);
        uint256 count = _hooks.length;
        for (uint256 i = 0; i < count; i++) {
            try
                IPostDispatchHook(_hooks[i]).postDispatch{value: msg.value}(
                    metadata,
                    message
                )
            {
                emit SuccessfulAggregationHookCall(_hooks[i]);
            } catch {
                emit ErroneousAggregationHookCall(_hooks[i]);
            }
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
            try
                IPostDispatchHook(_hooks[i]).quoteDispatch(metadata, message)
            returns (uint256 _quote) {
                total += _quote;
            } catch {}
        }
        return total;
    }

    function hooks(bytes calldata) public pure returns (address[] memory) {
        return abi.decode(MetaProxy.metadata(), (address[]));
    }
}
