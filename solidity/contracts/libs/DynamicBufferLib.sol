// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "forge-std/console.sol";
import {BytesLib} from "./BytesLib.sol";

library DynamicBufferLib {
    using BytesLib for bytes;

    struct Stack {
        bytes data;
    }

    function push(Stack memory stack, address[] memory items)
        internal
        pure
        returns (Stack memory)
    {
        for (uint256 i = 0; i < items.length; i++) {
            stack.data = push(stack, items[i]).data;
        }
        return stack;
    }

    function push(Stack memory stack, address item)
        internal
        pure
        returns (Stack memory)
    {
        stack.data = stack.data.concat(abi.encodePacked(item));
        return stack;
    }

    function pop(Stack memory stack)
        internal
        pure
        returns (Stack memory, address)
    {
        address item;
        uint256 popOffset = stack.data.length - 20;

        item = address(bytes20(stack.data.slice(popOffset, 20)));
        stack.data = stack.data.slice(0, popOffset);
        return (stack, item);
    }

    function isEmpty(Stack memory stack) internal pure returns (bool) {
        return stack.data.length == 0;
    }
}
