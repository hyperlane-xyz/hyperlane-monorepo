// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {TestRouter} from "../contracts/test/TestRouter.sol";
import {TestMailbox} from "../contracts/test/TestMailbox.sol";
import {TestInterchainGasPaymaster} from "../contracts/test/TestInterchainGasPaymaster.sol";
import {TestIsm} from "../contracts/test/TestIsm.sol";
import {TestMerkleTreeHook} from "../contracts/test/TestMerkleTreeHook.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract RouterTest is Test {
    TestRouter router;
    TestMailbox mailbox;
    TestInterchainGasPaymaster igp;
    TestMerkleTreeHook requiredHook;
    TestIsm ism;

    uint32 localDomain = 1000;
    uint32 origin = 1;
    uint32 destination = 2;
    uint32 destinationWithoutRouter = 3;
    bytes body = "0xdeadbeef";

    event Dispatch(
        address indexed sender,
        uint32 indexed destination,
        bytes32 indexed recipient,
        bytes message
    );

    function setUp() public {
        mailbox = new TestMailbox(localDomain);
        igp = new TestInterchainGasPaymaster();
        router = new TestRouter(address(mailbox));
        ism = new TestIsm();
        requiredHook = new TestMerkleTreeHook(address(mailbox));

        mailbox.initialize(
            address(this),
            address(ism),
            address(igp),
            address(requiredHook)
        );
        router.initialize(address(igp), address(ism));
    }

    function testInitialize() public {
        assertEq(address(router.hook()), address(igp));
        assertEq(address(router.interchainSecurityModule()), address(ism));
        assertEq(address(router.owner()), address(this));
        assertEq(address(router.mailbox()), address(mailbox));
        vm.expectRevert(
            bytes("Initializable: contract is already initialized")
        );
        router.initialize(address(igp), address(ism));
    }

    function testEnrolledMailboxAndRouter(bytes32 sender) public {
        bytes32 recipient = TypeCasts.addressToBytes32(address(router));
        router.enrollRemoteRouter(origin, sender);
        mailbox.testHandle(origin, sender, recipient, body);
    }

    function testUnenrolledMailbox(bytes32 sender) public {
        vm.expectRevert(bytes("MailboxClient: sender not mailbox"));
        router.handle(origin, sender, body);
    }

    function testUnenrolledRouter(bytes32 sender) public {
        bytes32 recipient = TypeCasts.addressToBytes32(address(router));
        vm.expectRevert(bytes("No router enrolled for domain: 1"));
        mailbox.testHandle(origin, sender, recipient, body);
    }

    function testOwnerEnrollRouter(bytes32 remoteRouter) public {
        vm.assume(remoteRouter != bytes32(0));
        assertEq(router.isRemoteRouter(origin, remoteRouter), false);
        vm.expectRevert(bytes("No router enrolled for domain: 1"));
        router.mustHaveRemoteRouter(origin);
        router.enrollRemoteRouter(origin, remoteRouter);
        assertEq(router.isRemoteRouter(origin, remoteRouter), true);
        assertEq(router.mustHaveRemoteRouter(origin), remoteRouter);
    }

    function testOwnerUnenrollRouter(bytes32 remoteRouter) public {
        vm.assume(remoteRouter != bytes32(0));
        assertEq(router.isRemoteRouter(origin, remoteRouter), false);
        vm.expectRevert(bytes("No router enrolled for domain: 1"));
        router.unenrollRemoteRouter(origin);
        router.enrollRemoteRouter(origin, remoteRouter);
        router.unenrollRemoteRouter(origin);
        assertEq(router.isRemoteRouter(origin, remoteRouter), false);
    }

    function testNotOwnerEnrollRouter(
        address notOwner,
        bytes32 remoteRouter
    ) public {
        vm.prank(notOwner);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        router.enrollRemoteRouter(origin, remoteRouter);
    }

    function testOwnerBatchEnrollRouter(bytes32 remoteRouter) public {
        vm.assume(remoteRouter != bytes32(0));
        assertEq(router.isRemoteRouter(origin, remoteRouter), false);
        vm.expectRevert(bytes("No router enrolled for domain: 1"));
        router.mustHaveRemoteRouter(origin);
        uint32[] memory domains = new uint32[](1);
        domains[0] = origin;
        bytes32[] memory addresses = new bytes32[](1);
        addresses[0] = remoteRouter;
        router.enrollRemoteRouters(domains, addresses);
        assertEq(router.isRemoteRouter(origin, remoteRouter), true);
        assertEq(router.mustHaveRemoteRouter(origin), remoteRouter);
    }

    function testOwnerBatchUnenrollRouter(bytes32 remoteRouter) public {
        vm.assume(remoteRouter != bytes32(0));
        assertEq(router.isRemoteRouter(origin, remoteRouter), false);
        vm.expectRevert(bytes("No router enrolled for domain: 1"));
        router.mustHaveRemoteRouter(origin);
        uint32[] memory domains = new uint32[](1);
        domains[0] = origin;
        bytes32[] memory addresses = new bytes32[](1);
        addresses[0] = remoteRouter;
        router.enrollRemoteRouters(domains, addresses);
        router.unenrollRemoteRouters(domains);
        assertEq(router.isRemoteRouter(origin, remoteRouter), false);
    }

    function testReturnDomains(bytes32 remoteRouter) public {
        uint32[] memory domains = new uint32[](2);
        domains[0] = origin;
        domains[1] = destination;
        bytes32[] memory addresses = new bytes32[](2);
        addresses[0] = remoteRouter;
        addresses[1] = remoteRouter;
        router.enrollRemoteRouters(domains, addresses);
        assertEq(router.domains()[0], domains[0]);
        assertEq(router.domains()[1], domains[1]);
    }

    function testDispatch(bytes32 remoteRouter) public {
        vm.assume(remoteRouter != bytes32(0));
        router.enrollRemoteRouter(destination, remoteRouter);
        uint256 fee = mailbox.quoteDispatch(destination, remoteRouter, body);
        vm.expectEmit(true, true, true, true, address(mailbox));
        vm.prank(address(router));
        bytes memory message = mailbox.buildOutboundMessage(
            destination,
            remoteRouter,
            body
        );
        emit Dispatch(address(router), destination, remoteRouter, message);
        router.dispatch{value: fee}(destination, body);

        vm.expectRevert(bytes("No router enrolled for domain: 3"));
        router.dispatch(destinationWithoutRouter, body);
    }

    function testDispatchInsufficientPayment(bytes32 remoteRouter) public {
        vm.assume(remoteRouter != bytes32(0));
        router.enrollRemoteRouter(destination, remoteRouter);
        vm.expectRevert(bytes("IGP: insufficient interchain gas payment"));
        router.dispatch(destination, body);
    }
}
