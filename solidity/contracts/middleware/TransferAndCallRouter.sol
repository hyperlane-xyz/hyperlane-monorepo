// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InterchainAccountRouter, CallLib} from "./InterchainAccountRouter.sol";
import {TokenRouter} from "../token/libs/TokenRouter.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

contract TransferAndCall {
    using TypeCasts for address;

    InterchainAccountRouter public immutable interchainAccountRouter;

    constructor(InterchainAccountRouter _interchainAccountRouter) {
        interchainAccountRouter = _interchainAccountRouter;
    }

    function transferAndCall(
        uint32 destination,
        uint256 amount,
        IERC20 asset, // not derivable from TokenRouter
        TokenRouter warpRoute,
        CallLib.Call[] calldata calls
    ) external payable {
        asset.transferFrom(msg.sender, address(this), amount);
        bytes32 self = interchainAccountRouter
            .getRemoteInterchainAccount(destination, address(this))
            .addressToBytes32();
        uint256 warpFee = warpRoute.quoteGasPayment(destination);
        warpRoute.transferRemote{value: warpFee}(destination, self, amount);
        interchainAccountRouter.callRemote{value: msg.value - warpFee}(
            destination,
            calls
        );
    }
}
