// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import {TestRouter} from "../contracts/test/TestRouter.sol";
import {TestMailbox} from "../contracts/test/TestMailbox.sol";
import {TestInterchainGasPaymaster} from "../contracts/test/TestInterchainGasPaymaster.sol";
import {TestMultisigIsm} from "../contracts/test/TestMultisigIsm.sol";
import {TestMerkleTreeHook} from "../contracts/test/TestMerkleTreeHook.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract RouterTest is Test {
    TestRouter router;
    TestMailbox mailbox;
    TestInterchainGasPaymaster igp;
    TestMerkleTreeHook requiredHook;
    TestMultisigIsm ism;

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
        ism = new TestMultisigIsm();
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

    function testEnrolledMailboxAndRouter() public {
        bytes32 sender = TypeCasts.addressToBytes32(address(1));
        bytes32 recipient = TypeCasts.addressToBytes32(address(router));
        router.enrollRemoteRouter(origin, sender);
        mailbox.testHandle(origin, sender, recipient, body);
    }

    function testUnenrolledMailbox() public {
        vm.expectRevert(bytes("MailboxClient: sender not mailbox"));
        router.handle(origin, TypeCasts.addressToBytes32(address(1)), body);
    }

    function testUnenrolledRouter() public {
        bytes32 sender = TypeCasts.addressToBytes32(address(1));
        bytes32 recipient = TypeCasts.addressToBytes32(address(router));
        vm.expectRevert(bytes("No router enrolled for domain: 1"));
        mailbox.testHandle(origin, sender, recipient, body);
    }

    function testOwnerEnrollRouter() public {
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        assertEq(router.isRemoteRouter(origin, remote), false);
        vm.expectRevert(bytes("No router enrolled for domain: 1"));
        router.mustHaveRemoteRouter(origin);
        router.enrollRemoteRouter(origin, remote);
        assertEq(router.isRemoteRouter(1, remote), true);
        assertEq(router.mustHaveRemoteRouter(1), remote);
    }

    function testOwnerUnenrollRouter() public {
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        assertEq(router.isRemoteRouter(origin, remote), false);
        vm.expectRevert(bytes("No router enrolled for domain: 1"));
        router.unenrollRemoteRouter(origin);
        router.enrollRemoteRouter(origin, remote);
        router.unenrollRemoteRouter(origin);
        assertEq(router.isRemoteRouter(origin, remote), false);
    }

    function testNotOwnerEnrollRouter() public {
        vm.prank(address(1));
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        router.enrollRemoteRouter(origin, remote);
    }

    function testOwnerBatchEnrollRouter() public {
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        assertEq(router.isRemoteRouter(origin, remote), false);
        vm.expectRevert(bytes("No router enrolled for domain: 1"));
        router.mustHaveRemoteRouter(origin);
        uint32[] memory domains = new uint32[](1);
        domains[0] = origin;
        bytes32[] memory addresses = new bytes32[](1);
        addresses[0] = remote;
        router.enrollRemoteRouters(domains, addresses);
        assertEq(router.isRemoteRouter(origin, remote), true);
        assertEq(router.mustHaveRemoteRouter(origin), remote);
    }

    function testOwnerBatchUnenrollRouter() public {
        bytes32 remote = TypeCasts.addressToBytes32(address(1));
        assertEq(router.isRemoteRouter(origin, remote), false);
        vm.expectRevert(bytes("No router enrolled for domain: 1"));
        router.mustHaveRemoteRouter(origin);
        uint32[] memory domains = new uint32[](1);
        domains[0] = origin;
        bytes32[] memory addresses = new bytes32[](1);
        addresses[0] = remote;
        router.enrollRemoteRouters(domains, addresses);
        router.unenrollRemoteRouters(domains);
        assertEq(router.isRemoteRouter(origin, remote), false);
    }

    function testReturnDomains() public {
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

    function formatMessage(
        uint8 _version,
        uint32 _nonce,
        uint32 _originDomain,
        bytes32 _sender,
        uint32 _destinationDomain,
        bytes32 _recipient,
        bytes memory _messageBody
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                _version,
                _nonce,
                _originDomain,
                _sender,
                _destinationDomain,
                _recipient,
                _messageBody
            );
    }

    function testDispatch() public {
        bytes32 recipient = TypeCasts.addressToBytes32(address(router));
        router.enrollRemoteRouter(
            destination,
            TypeCasts.addressToBytes32(address(1))
        );
        uint256 fee = mailbox.quoteDispatch(destination, recipient, body);
        vm.expectEmit(true, true, true, true, address(mailbox));
        bytes memory message = formatMessage(
            mailbox.VERSION(),
            mailbox.nonce(),
            localDomain,
            TypeCasts.addressToBytes32(address(router)),
            destination,
            TypeCasts.addressToBytes32(address(1)),
            body
        );
        emit Dispatch(
            address(router),
            destination,
            TypeCasts.addressToBytes32(address(1)),
            message
        );
        router.dispatch{value: fee}(destination, body);

        vm.expectRevert(bytes("No router enrolled for domain: 3"));
        router.dispatch(destinationWithoutRouter, body);
    }

    function testDispatchInsufficientPayment() public {
        router.enrollRemoteRouter(
            destination,
            TypeCasts.addressToBytes32(address(1))
        );
        vm.expectRevert(bytes("IGP: insufficient interchain gas payment"));
        router.dispatch(destination, body);
    }
}
