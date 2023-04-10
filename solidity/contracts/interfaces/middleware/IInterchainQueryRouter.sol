// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {CallLib} from "../../libs/Call.sol";

interface IInterchainQueryRouter {
    function query(
        uint32 _destination,
        address _to,
        bytes memory _data,
        bytes memory _callback
    ) external returns (bytes32);

    function query(
        uint32 _destination,
        CallLib.StaticCallWithCallback[] calldata calls
    ) external returns (bytes32);
}
