// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {HypVeruLink} from "../../contracts/token/extensions/HypVeruLink.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";
import {ProtocolFee} from "../../contracts/hooks/ProtocolFee.sol";

// Matches VeruLink's void-returning mint and allowance-based burnFrom interface.
contract VeruLinkTokenMock is ERC20Burnable {
    address public minter;

    constructor() ERC20("Wrapped ALEO", "ALEO") {
        _mint(msg.sender, 100e6);
    }

    function setMinter(address _minter) external {
        minter = _minter;
    }

    function mint(address _recipient, uint256 _amount) external {
        require(msg.sender == minter, "not minter");
        _mint(_recipient, _amount);
    }
}

contract HypVeruLinkTest is Test {
    using TypeCasts for address;
    using Message for bytes;

    uint32 internal constant REMOTE_DOMAIN = 12;
    uint256 internal constant AMOUNT = 10e6;
    address internal constant ALICE = address(0x1);
    bytes32 internal constant REMOTE_ROUTER = bytes32(uint256(123));
    VeruLinkTokenMock internal token;
    HypVeruLink internal router;
    MockMailbox internal mailbox;

    function setUp() public {
        mailbox = new MockMailbox(11);
        TestPostDispatchHook hook = new TestPostDispatchHook();
        mailbox.setDefaultHook(address(hook));
        mailbox.setRequiredHook(address(hook));
        mailbox.addRemoteMailbox(REMOTE_DOMAIN, new MockMailbox(REMOTE_DOMAIN));
        token = new VeruLinkTokenMock();
        router = _deployRouter(1, 1, address(hook));
        router.enrollRemoteRouter(REMOTE_DOMAIN, REMOTE_ROUTER);
        token.setMinter(address(router));
        token.transfer(ALICE, AMOUNT);
        vm.deal(ALICE, 1 ether);
    }

    function _deployRouter(
        uint256 numerator,
        uint256 denominator,
        address hook
    ) internal returns (HypVeruLink) {
        HypVeruLink implementation = new HypVeruLink(
            address(token),
            numerator,
            denominator,
            address(mailbox)
        );
        return
            HypVeruLink(
                address(
                    new TransparentUpgradeableProxy(
                        address(implementation),
                        address(0x37),
                        abi.encodeCall(
                            HypVeruLink.initialize,
                            (address(hook), address(0), address(this))
                        )
                    )
                )
            );
    }

    function testTransferRemoteBurnsWithAllowance() public {
        vm.startPrank(ALICE);
        token.approve(address(router), AMOUNT);
        vm.expectCall(
            address(token),
            abi.encodeCall(ERC20Burnable.burnFrom, (ALICE, AMOUNT))
        );
        router.transferRemote{value: 1 ether}(
            REMOTE_DOMAIN,
            ALICE.addressToBytes32(),
            AMOUNT
        );
        vm.stopPrank();
        assertEq(token.balanceOf(ALICE), 0);
        assertEq(token.totalSupply(), 90e6);
        assertEq(token.allowance(ALICE, address(router)), 0);
        assertEq(mailbox.nonce(), 1);
    }

    function testTransferRemoteRequiresAllowance(uint256 allowance) public {
        allowance = bound(allowance, 0, AMOUNT - 1);
        vm.startPrank(ALICE);
        token.approve(address(router), allowance);
        vm.expectRevert("ERC20: insufficient allowance");
        router.transferRemote{value: 1 ether}(
            REMOTE_DOMAIN,
            ALICE.addressToBytes32(),
            AMOUNT
        );
        vm.stopPrank();
        assertEq(token.balanceOf(ALICE), AMOUNT);
        assertEq(token.totalSupply(), 100e6);
        assertEq(token.allowance(ALICE, address(router)), allowance);
        assertEq(mailbox.nonce(), 0);
    }

    function testHandleMintsExistingToken() public {
        token.setMinter(address(0));
        vm.prank(address(mailbox));
        vm.expectRevert("not minter");
        router.handle(
            REMOTE_DOMAIN,
            REMOTE_ROUTER,
            abi.encodePacked(ALICE.addressToBytes32(), AMOUNT)
        );
        assertEq(token.balanceOf(ALICE), AMOUNT);
        assertEq(token.totalSupply(), 100e6);

        token.setMinter(address(router));
        vm.prank(address(mailbox));
        router.handle(
            REMOTE_DOMAIN,
            REMOTE_ROUTER,
            abi.encodePacked(ALICE.addressToBytes32(), AMOUNT)
        );
        assertEq(router.token(), address(token));
        assertEq(token.balanceOf(ALICE), 2 * AMOUNT);
        assertEq(token.totalSupply(), 110e6);
    }

    function _configureNativeFees()
        internal
        returns (TestInterchainGasPaymaster igp, ProtocolFee required)
    {
        igp = new TestInterchainGasPaymaster();
        required = new ProtocolFee(100, 100, address(this), address(this));
        mailbox.setRequiredHook(address(required));
        router.setHook(address(igp));
        router.setDestinationGas(REMOTE_DOMAIN, 50_000);
    }

    function testQuoteMatchesNativePaymentAndRefund(uint96 overpayment) public {
        overpayment = uint96(bound(overpayment, 0, 1e15));
        (
            TestInterchainGasPaymaster igp,
            ProtocolFee required
        ) = _configureNativeFees();
        vm.startPrank(ALICE);
        Quote[] memory quotes = router.quoteTransferRemote(
            REMOTE_DOMAIN,
            ALICE.addressToBytes32(),
            AMOUNT
        );
        assertEq(quotes.length, 3);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 50_000 * igp.gasPrice() + 100);
        assertEq(router.quoteGasPayment(REMOTE_DOMAIN), quotes[0].amount);
        assertEq(quotes[1].token, address(token));
        assertEq(quotes[1].amount, AMOUNT);
        assertEq(quotes[2].token, address(token));
        assertEq(quotes[2].amount, 0);
        token.approve(address(router), AMOUNT);
        uint256 balanceBefore = ALICE.balance;
        router.transferRemote{value: quotes[0].amount + overpayment}(
            REMOTE_DOMAIN,
            ALICE.addressToBytes32(),
            AMOUNT
        );
        vm.stopPrank();
        assertEq(ALICE.balance, balanceBefore - quotes[0].amount);
        assertEq(address(igp).balance, 50_000 * igp.gasPrice());
        assertEq(address(required).balance, 100);
        assertEq(token.totalSupply(), 90e6);
        assertEq(address(router).balance, 0);
        MockMailbox remote = mailbox.remoteMailboxes(REMOTE_DOMAIN);
        this.assertTokenMessage(remote.inboundMessages(0), AMOUNT);
    }

    function testUnderpaidGasRollsBackBurnAndAllowance() public {
        (
            TestInterchainGasPaymaster igp,
            ProtocolFee required
        ) = _configureNativeFees();
        uint256 fee = router.quoteGasPayment(REMOTE_DOMAIN);
        vm.startPrank(ALICE);
        token.approve(address(router), AMOUNT);
        vm.expectRevert("IGP: insufficient interchain gas payment");
        router.transferRemote{value: fee - 1}(
            REMOTE_DOMAIN,
            ALICE.addressToBytes32(),
            AMOUNT
        );
        vm.stopPrank();
        assertEq(token.balanceOf(ALICE), AMOUNT);
        assertEq(token.totalSupply(), 100e6);
        assertEq(token.allowance(ALICE, address(router)), AMOUNT);
        assertEq(mailbox.nonce(), 0);
        assertEq(address(igp).balance, 0);
        assertEq(address(required).balance, 0);
    }

    function testScalingSixToEighteenDecimals() public {
        router = _deployRouter(1e12, 1, address(0));
        router.enrollRemoteRouter(REMOTE_DOMAIN, REMOTE_ROUTER);
        token.setMinter(address(router));
        Quote[] memory quotes = router.quoteTransferRemote(
            REMOTE_DOMAIN,
            ALICE.addressToBytes32(),
            AMOUNT
        );
        assertEq(quotes[1].amount, AMOUNT);
        vm.startPrank(ALICE);
        token.approve(address(router), AMOUNT);
        router.transferRemote(REMOTE_DOMAIN, ALICE.addressToBytes32(), AMOUNT);
        vm.stopPrank();
        MockMailbox remote = mailbox.remoteMailboxes(REMOTE_DOMAIN);
        bytes memory body = this.assertTokenMessage(
            remote.inboundMessages(0),
            AMOUNT * 1e12
        );
        vm.prank(address(mailbox));
        router.handle(REMOTE_DOMAIN, REMOTE_ROUTER, body);
        assertEq(token.balanceOf(ALICE), AMOUNT);
        assertEq(token.totalSupply(), 100e6);
    }

    function assertTokenMessage(
        bytes calldata message,
        uint256 amount
    ) external returns (bytes memory) {
        assertEq(
            TokenMessage.recipient(message.body()),
            ALICE.addressToBytes32()
        );
        assertEq(TokenMessage.amount(message.body()), amount);
        return message.body();
    }

    function testHandleRejectsUnauthorizedDelivery() public {
        bytes memory body = abi.encodePacked(ALICE.addressToBytes32(), AMOUNT);
        vm.prank(ALICE);
        vm.expectRevert("MailboxClient: sender not mailbox");
        router.handle(REMOTE_DOMAIN, REMOTE_ROUTER, body);
        vm.prank(address(mailbox));
        vm.expectRevert("Enrolled router does not match sender");
        router.handle(REMOTE_DOMAIN, bytes32(uint256(456)), body);
        assertEq(token.totalSupply(), 100e6);
    }

    function testImplementationCannotBeInitialized() public {
        HypVeruLink implementation = new HypVeruLink(
            address(token),
            1,
            1,
            address(mailbox)
        );
        vm.expectRevert("Initializable: contract is already initialized");
        implementation.initialize(address(0), address(0), ALICE);
    }

    function testInitializationAndOwnerConfigurationAreProtected() public {
        vm.expectRevert("Initializable: contract is already initialized");
        router.initialize(address(0), address(0), ALICE);
        vm.startPrank(ALICE);
        vm.expectRevert("Ownable: caller is not the owner");
        router.setHook(address(0));
        vm.expectRevert("Ownable: caller is not the owner");
        router.enrollRemoteRouter(REMOTE_DOMAIN, ALICE.addressToBytes32());
        vm.expectRevert("Ownable: caller is not the owner");
        router.setFeeHook(address(0));
        vm.stopPrank();
        assertEq(router.owner(), address(this));
    }

    function testFeeRecipientDisablesQuotesAndTransfersUntilRemoved() public {
        router.setFeeRecipient(address(0xFEE));
        vm.expectRevert("TokenRouter: token fees unsupported");
        router.quoteTransferRemote(
            REMOTE_DOMAIN,
            ALICE.addressToBytes32(),
            AMOUNT
        );
        vm.expectRevert("TokenRouter: token fees unsupported");
        router.transferRemote(REMOTE_DOMAIN, ALICE.addressToBytes32(), AMOUNT);
        router.setFeeRecipient(address(0));
        assertEq(
            router
            .quoteTransferRemote(
                REMOTE_DOMAIN,
                ALICE.addressToBytes32(),
                AMOUNT
            )[1].amount,
            AMOUNT
        );
    }

    // Known inherited limitation: the fee-hook path treats an external mint/burn
    // token as collateral and burns the fee instead of retaining it for the IGP.
    function testERC20GasFeeQuoteDoesNotGuaranteeExecutableTransfer() public {
        TestInterchainGasPaymaster igp = new TestInterchainGasPaymaster();
        router.setHook(address(igp));
        router.setFeeHook(address(igp));
        router.setDestinationGas(REMOTE_DOMAIN, 50_000);
        Quote[] memory quotes = router.quoteTransferRemote(
            REMOTE_DOMAIN,
            ALICE.addressToBytes32(),
            AMOUNT / 2
        );
        uint256 fee = 50_000 * igp.gasPrice();
        assertEq(quotes[0].token, address(token));
        assertEq(quotes[0].amount, fee);
        vm.startPrank(ALICE);
        token.approve(address(router), AMOUNT / 2 + fee);
        vm.expectRevert("ERC20: transfer amount exceeds balance");
        router.transferRemote(
            REMOTE_DOMAIN,
            ALICE.addressToBytes32(),
            AMOUNT / 2
        );
        vm.stopPrank();
        assertEq(token.balanceOf(ALICE), AMOUNT);
        assertEq(token.totalSupply(), 100e6);
        assertEq(mailbox.nonce(), 0);
    }
}
