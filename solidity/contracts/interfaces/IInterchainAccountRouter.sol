// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {CallLib} from "../middleware/libs/Call.sol";

interface IInterchainAccountRouter {
    function quoteGasPayment(
        uint32 _destination,
        uint256 _gasLimit
    ) external view returns (uint256);

    function callRemote(
        uint32 _destination,
        CallLib.Call[] calldata _calls,
        bytes memory _hookMetadata
    ) external payable returns (bytes32);
}
