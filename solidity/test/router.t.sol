// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {TestRouter} from "../contracts/test/TestRouter.sol";
import {TestMailbox} from "../contracts/test/TestMailbox.sol";
import {TestInterchainGasPaymaster} from "../contracts/test/TestInterchainGasPaymaster.sol";
import {TestMultisigIsm} from "../contracts/test/TestMultisigIsm.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract RouterTest is Test {
    TestRouter router;
    TestMailbox mailbox;
    TestInterchainGasPaymaster igp;
    TestMultisigIsm ism;

    uint32 origin = 1;
    uint32 destination = 2;
    uint32 destinationWithoutRouter = 3;
    bytes body = "0xdeadbeef";

    event InitializeOverload();

    function setUp() public {
        mailbox = new TestMailbox(1000);
        igp = new TestInterchainGasPaymaster(address(this));
        router = new TestRouter();
        ism = new TestMultisigIsm();
        ism.setAccept(true);
    }

    function testInitialize() public {
        vm.expectEmit(false, false, false, false);
        emit InitializeOverload();
        router.initialize(address(mailbox), address(igp));
        assertEq(address(router.mailbox()), address(mailbox));
        assertEq(address(router.interchainGasPaymaster()), address(igp));
        assertEq(address(router.owner()), address(this));

        vm.expectRevert(
            bytes("Initializable: contract is already initialized")
        );
        router.initialize(address(mailbox), address(igp));
    }

    function testEnrolledMailboxAndRouter() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        bytes32 sender = TypeCasts.addressToBytes32(address(1));
        bytes32 recipient = TypeCasts.addressToBytes32(address(router));
        router.enrollRemoteRouter(origin, sender);
        // Does not revert.
        mailbox.testHandle(origin, sender, recipient, body);
    }

    function testUnenrolledMailbox() public {
        vm.expectRevert(bytes("!mailbox"));
        router.handle(origin, TypeCasts.addressToBytes32(address(1)), body);
    }

    function testUnenrolledRouter() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        bytes32 sender = TypeCasts.addressToBytes32(address(1));
        bytes32 recipient = TypeCasts.addressToBytes32(address(router));
        vm.expectRevert(
            bytes(
                "No router enrolled for domain. Did you specify the right domain ID?"
            )
        );
        mailbox.testHandle(origin, sender, recipient, body);
    }

    function testOwnerEnrollRouter() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        assertEq(router.isRemoteRouter(origin, remote), false);
        vm.expectRevert(
            bytes(
                "No router enrolled for domain. Did you specify the right domain ID?"
            )
        );
        router.mustHaveRemoteRouter(origin);

        router.enrollRemoteRouter(origin, remote);
        assertEq(router.isRemoteRouter(1, remote), true);
        assertEq(router.mustHaveRemoteRouter(1), remote);
    }

    function testNotOwnerEnrollRouter() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        vm.prank(address(1));
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        router.enrollRemoteRouter(origin, remote);
    }

    function testOwnerBatchEnrollRouter() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        assertEq(router.isRemoteRouter(origin, remote), false);
        vm.expectRevert(
            bytes(
                "No router enrolled for domain. Did you specify the right domain ID?"
            )
        );
        router.mustHaveRemoteRouter(origin);
        uint32[] memory domains = new uint32[](1);
        domains[0] = origin;
        bytes32[] memory addresses = new bytes32[](1);
        addresses[0] = remote;
        router.enrollRemoteRouters(domains, addresses);
        assertEq(router.isRemoteRouter(origin, remote), true);
        assertEq(router.mustHaveRemoteRouter(origin), remote);
    }

    function testReturnDomains() public {
        router.initialize(address(mailbox), address(igp));
        mailbox.initialize(address(this), address(ism));
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        uint32[] memory domains = new uint32[](2);
        domains[0] = origin;
        domains[1] = destination;
        bytes32[] memory addresses = new bytes32[](2);
        addresses[0] = remote;
        addresses[1] = remote;
        router.enrollRemoteRouters(domains, addresses);
        assertEq(router.domains()[0], domains[0]);
        assertEq(router.domains()[1], domains[1]);
    }
}
