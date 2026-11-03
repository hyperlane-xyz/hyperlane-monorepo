// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {StandardHookMetadata} from "../contracts/hooks/libs/StandardHookMetadata.sol";
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

    function test_callRemoteWithOverrides_withERC20Fee_usesMailboxDefaultHook()
        public
    {
        environment.mailboxes(origin).setDefaultHook(address(erc20Igp));
        InterchainAccountRouter defaultHookRouter = deployIcaRouter(
            environment.mailboxes(origin),
            IPostDispatchHook(address(0)),
            address(this)
        );
        feeToken.approve(address(defaultHookRouter), type(uint256).max);

        bytes memory hookMetadata = StandardHookMetadata.formatWithFeeToken(
            0,
            GAS_LIMIT_OVERRIDE,
            address(this),
            address(feeToken)
        );
        uint256 feeQuote = erc20Igp.quoteGasPayment(
            address(feeToken),
            destination,
            GAS_LIMIT_OVERRIDE
        );

        defaultHookRouter.callRemoteWithOverrides(
            destination,
            routerOverride,
            ismOverride,
            getCalls(bytes32("minimal_default_hook"), 0),
            hookMetadata
        );

        assertEq(feeToken.balanceOf(address(erc20Igp)), feeQuote);
        assertEq(feeToken.balanceOf(address(defaultHookRouter)), 0);
        assertEq(
            feeToken.allowance(address(defaultHookRouter), address(erc20Igp)),
            type(uint256).max
        );
        assertEq(feeToken.allowance(address(defaultHookRouter), address(0)), 0);
        assertEq(defaultHookRouter.routers(destination), bytes32(0));
    }
}
