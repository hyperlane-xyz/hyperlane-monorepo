// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {MockMailbox} from "../contracts/mock/MockMailbox.sol";
import {CallLib, InterchainAccountRouter} from "../contracts/middleware/InterchainAccountRouter.sol";
import {MinimalInterchainAccountRouter} from "../contracts/middleware/MinimalInterchainAccountRouter.sol";
import {InterchainAccountRouterTestBase} from "./InterchainAccountRouter.t.sol";

/// @dev Runs the shared ICA test suite against MinimalInterchainAccountRouter.
/// The MinimalInterchainAccountRouter is cast to InterchainAccountRouter — this works
/// because the EVM dispatches by function selector, and all shared test methods
/// exist on both contracts with identical signatures.
contract MinimalInterchainAccountRouterTest is InterchainAccountRouterTestBase {
    function deployIcaRouter(
        MockMailbox _mailbox,
        IPostDispatchHook _customHook,
        address _owner
    ) public override returns (InterchainAccountRouter) {
        return
            InterchainAccountRouter(
                payable(
                    address(
                        new MinimalInterchainAccountRouter(
                            address(_mailbox),
                            address(_customHook),
                            _owner
                        )
                    )
                )
            );
    }
}
