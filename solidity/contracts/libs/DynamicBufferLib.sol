// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {BytesLib} from "./BytesLib.sol";

library DynamicBufferLib {
    using BytesLib for bytes;

    struct Stack {
        bytes data;
    }

    function push(Stack memory stack, address[] memory item)
        internal
        pure
        returns (Stack memory)
    {
        stack.data.concat(abi.encodePacked(item));
        return stack;
    }

    function push(Stack memory stack, address item)
        internal
        pure
        returns (Stack memory)
    {
        stack.data.concat(abi.encodePacked(item));
        return stack;
    }

    function pop(Stack memory stack) internal pure returns (address) {
        address item;
        uint256 popOffset = stack.data.length - 20;

        item = address(bytes20(stack.data.slice(popOffset, 20)));
        stack.data = stack.data.slice(0, popOffset);

        return item;
    }

    function isEmpty(Stack memory stack) internal pure returns (bool) {
        return stack.data.length == 0;
    }
}
