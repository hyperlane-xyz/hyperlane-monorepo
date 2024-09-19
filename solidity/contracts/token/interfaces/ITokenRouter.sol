// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {IRouter} from "../../interfaces/IRouter.sol";

interface ITokenRouter {
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId
    ) external payable returns (bytes32 messageId);

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId,
        bytes calldata _hookMetadata,
        address _hook
    ) external payable returns (bytes32 messageId);

    function balanceOf(address account) external returns (uint256);
}
