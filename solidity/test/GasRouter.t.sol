// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/mock/MockHyperlaneEnvironment.sol";
import "../contracts/test/TestGasRouter.sol";

contract GasRouterTest is Test {
    event DestinationGasSet(uint32 indexed domain, uint256 gas);

    MockHyperlaneEnvironment environment;

    uint32 originDomain = 1;
    uint32 remoteDomain = 2;

    uint256 gasPrice = 1; // from IGP.quoteGasPayment

    TestGasRouter originRouter;
    TestGasRouter remoteRouter;

    function setUp() public {
        environment = new MockHyperlaneEnvironment(originDomain, remoteDomain);
        environment.igps(originDomain).setGasPrice(gasPrice);
        environment.igps(remoteDomain).setGasPrice(gasPrice);

        originRouter = new TestGasRouter();
        remoteRouter = new TestGasRouter();

        originRouter.initialize(
            address(environment.mailboxes(originDomain)),
            address(environment.igps(originDomain))
        );
        remoteRouter.initialize(
            address(environment.mailboxes(remoteDomain)),
            address(environment.igps(remoteDomain))
        );

        originRouter.enrollRemoteRouter(
            remoteDomain,
            TypeCasts.addressToBytes32(address(remoteRouter))
        );
        remoteRouter.enrollRemoteRouter(
            originDomain,
            TypeCasts.addressToBytes32(address(originRouter))
        );
    }

    function setDestinationGas(
        GasRouter gasRouter,
        uint32 domain,
        uint256 gas
    ) public {
        GasRouter.GasRouterConfig[]
            memory gasConfigs = new GasRouter.GasRouterConfig[](1);
        gasConfigs[0] = GasRouter.GasRouterConfig(domain, gas);
        gasRouter.setDestinationGas(gasConfigs);
    }

    function testSetDestinationGas(uint256 gas) public {
        vm.expectEmit(true, false, false, true, address(remoteRouter));
        emit DestinationGasSet(originDomain, gas);
        setDestinationGas(remoteRouter, originDomain, gas);
        assertEq(remoteRouter.destinationGas(originDomain), gas);

        vm.expectEmit(true, false, false, true, address(originRouter));
        emit DestinationGasSet(remoteDomain, gas);
        setDestinationGas(originRouter, remoteDomain, gas);
        assertEq(originRouter.destinationGas(remoteDomain), gas);
    }

    function testQuoteGasPayment(uint256 gas) public {
        vm.assume(gas > 0 && type(uint256).max / gas > gasPrice);

        setDestinationGas(originRouter, remoteDomain, gas);
        assertEq(originRouter.quoteGasPayment(remoteDomain), gas * gasPrice);

        setDestinationGas(remoteRouter, originDomain, gas);
        assertEq(remoteRouter.quoteGasPayment(originDomain), gas * gasPrice);
    }

    uint256 refund = 0;
    bool passRefund = true;

    fallback() external payable {
        refund = msg.value;
        assert(passRefund);
    }

    function testDispatchWithGas(uint256 gas) public {
        vm.assume(gas > 0 && type(uint256).max / gas > gasPrice);
        vm.deal(address(this), gas * gasPrice);

        setDestinationGas(originRouter, remoteDomain, gas);
        vm.expectRevert("insufficient interchain gas payment");
        originRouter.dispatchWithGas{value: gas * gasPrice - 1}(
            remoteDomain,
            ""
        );
        vm.deal(address(this), gas * gasPrice + 1);
        originRouter.dispatchWithGas{value: gas * gasPrice + 1}(
            remoteDomain,
            ""
        );
        assertEq(refund, 1);

        vm.deal(address(this), gas * gasPrice + 1);
        passRefund = false;
        vm.expectRevert("Interchain gas payment refund failed");
        originRouter.dispatchWithGas{value: gas * gasPrice + 1}(
            remoteDomain,
            ""
        );
    }
}
