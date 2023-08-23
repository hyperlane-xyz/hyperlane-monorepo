// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

contract TestPostDispatchHook is IPostDispatchHook {
    // for aggregationHook
    bytes public requiredMetadata;
    uint256 public mockGasQuote = 25000;

    function setRequiredMetadata(bytes memory _requiredMetadata) public {
        requiredMetadata = _requiredMetadata;
    }

    function postDispatch(
        bytes calldata, /*metadata*/
        bytes calldata /*message*/
    ) external payable override {
        // test - empty
    }

    function quoteDispatch(
        bytes calldata, /*metadata*/
        bytes calldata /*message*/
    ) external view override returns (uint256) {
        return mockGasQuote;
    }
}
