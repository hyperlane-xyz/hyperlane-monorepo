// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "../contracts/test/TestGasRouter.sol";
import "../contracts/test/TestMailbox.sol";
import "../contracts/test/TestIsm.sol";
import "../contracts/test/TestInterchainGasPaymaster.sol";
import "../contracts/test/TestMerkleTreeHook.sol";

contract GasRouterTest is Test {
    event DestinationGasSet(uint32 indexed domain, uint256 gas);

    uint32 originDomain = 1;
    uint32 remoteDomain = 2;

    uint256 gasPrice; // The gas price used in IGP.quoteGasPayment

    TestMailbox originMailbox;
    TestMailbox remoteMailbox;

    TestGasRouter originRouter;
    TestGasRouter remoteRouter;

    function setUp() public {
        originMailbox = new TestMailbox(originDomain);
        TestIsm ism = new TestIsm();
        TestInterchainGasPaymaster igp = new TestInterchainGasPaymaster();
        TestMerkleTreeHook _requiredHook = new TestMerkleTreeHook(
            address(originMailbox)
        );
        originMailbox.initialize(
            address(this),
            address(ism),
            address(igp),
            address(_requiredHook)
        );
        remoteMailbox = new TestMailbox(remoteDomain);
        remoteMailbox.initialize(
            address(this),
            address(ism),
            address(igp),
            address(_requiredHook)
        );

        // Same for origin and remote
        gasPrice = igp.gasPrice();

        originRouter = new TestGasRouter(address(originMailbox));
        remoteRouter = new TestGasRouter(address(remoteMailbox));

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
        gasRouter.setDestinationGas(domain, gas);
    }

    function testSetDestinationGas(uint256 gas) public {
        setDestinationGas(remoteRouter, originDomain, gas);
        assertEq(remoteRouter.destinationGas(originDomain), gas);

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

    receive() external payable {
        refund = msg.value;
        assert(passRefund);
    }

    function testDispatch(uint256 gas) public {
        vm.assume(gas > 0 && type(uint256).max / gas > gasPrice);
        vm.deal(address(this), gas * gasPrice);

        setDestinationGas(originRouter, remoteDomain, gas);

        uint256 requiredPayment = gas * gasPrice;
        vm.expectRevert("IGP: insufficient interchain gas payment");
        originRouter.dispatch{value: requiredPayment - 1}(remoteDomain, "");

        vm.deal(address(this), requiredPayment + 1);
        originRouter.dispatch{value: requiredPayment + 1}(remoteDomain, "");
        assertEq(refund, 1);

        // Reset the IGP balance to avoid a balance overflow
        vm.deal(address(originMailbox.defaultHook()), 0);

        vm.deal(address(this), requiredPayment + 1);
        passRefund = false;
        vm.expectRevert(
            "Address: unable to send value, recipient may have reverted"
        );
        originRouter.dispatch{value: requiredPayment + 1}(remoteDomain, "");
    }
}
