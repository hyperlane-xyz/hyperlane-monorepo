// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {SendParam} from "./layerzero/IOFT.sol";

interface IKatanaVaultComposer {
    function depositAndSend(
        uint256 assets,
        SendParam calldata sendParam,
        address refundAddress
    ) external payable;
}
