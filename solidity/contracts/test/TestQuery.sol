// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {InterchainQueryRouter} from "../middleware/InterchainQueryRouter.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {CallLib} from "../libs/Call.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract TestQuery {
    InterchainQueryRouter public router;

    event Owner(uint256, address);

    constructor(address _router) {
        router = InterchainQueryRouter(_router);
    }

    /**
     * @dev Fetches owner of InterchainQueryRouter on provided domain and passes along with provided secret to `this.receiveRouterOwner`
     */
    function queryRouterOwner(uint32 domain, uint256 secret) external {
        address target = TypeCasts.bytes32ToAddress(router.routers(domain));
        CallLib.StaticCallWithCallback[]
            memory calls = new CallLib.StaticCallWithCallback[](1);
        calls[0] = CallLib.build(
            target,
            abi.encodeWithSelector(Ownable.owner.selector),
            abi.encodeWithSelector(this.receiveRouterOwner.selector, secret)
        );
        router.query(domain, calls);
    }

    /**
     * @dev `msg.sender` must be restricted to `this.router` to prevent any local account from spoofing query data.
     */
    function receiveRouterOwner(uint256 secret, address owner) external {
        require(msg.sender == address(router), "TestQuery: not from router");
        emit Owner(secret, owner);
    }
}
