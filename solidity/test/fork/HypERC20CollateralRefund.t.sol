// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Router} from "../../contracts/client/Router.sol";
import {IMailbox} from "../../contracts/interfaces/IMailbox.sol";
import {TrustedRelayerIsm} from "../../contracts/isms/TrustedRelayerIsm.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

/**
 * @title HypERC20CollateralRefundForkTest
 * @notice Fork test that verifies the refund logic on an Ink fork.
 *         Reads depositor/amount data from REFUND_RECIPIENTS and REFUND_AMOUNTS env vars
 *         (set by refund-pipeline.sh).
 *
 *         Run: REFUND_RECIPIENTS=0x...,0x... REFUND_AMOUNTS=123,456 \
 *              forge test --fork-url <INK_RPC> --match-contract HypERC20CollateralRefundForkTest -vvv
 */
contract HypERC20CollateralRefundForkTest is Test {
    using TypeCasts for address;

    // Ink chain contracts
    address constant OLD_ROUTER = 0x39d3c2Cf646447ee302178EDBe5a15E13B6F33aC;
    address constant MAILBOX_ADDR = 0x7f50C5776722630a0024fAE05fDe8b47571D7B39;
    address constant USDC = 0xF1815bd50389c46847f0Bda824eC8da914045D14;
    address constant SAFE = 0x11BEBBf509248735203BAAAe90c1a27EEE70D567;

    uint32 constant REMOTE_DOMAIN = 42161;
    uint8 constant MAILBOX_VERSION = 3;

    // Fields in alphabetical order for vm.parseJson compatibility
    struct Refund {
        uint256 amount;
        address recipient;
    }

    IERC20 usdc;
    IMailbox mailbox;
    bytes32 remoteRouter;
    Refund[] refunds;

    function setUp() public {
        // Skip if not on a fork (handles CI without fork URL)
        vm.skip(OLD_ROUTER.code.length == 0);

        usdc = IERC20(USDC);
        mailbox = IMailbox(MAILBOX_ADDR);
        remoteRouter = Router(OLD_ROUTER).routers(REMOTE_DOMAIN);
        vm.deal(SAFE, 1 ether);

        // Load refund data from env vars (set by refund-pipeline.sh)
        address[] memory recipients = vm.envAddress("REFUND_RECIPIENTS", ",");
        uint256[] memory amounts = vm.envUint("REFUND_AMOUNTS", ",");
        require(recipients.length == amounts.length, "Refund length mismatch");

        for (uint256 i = 0; i < recipients.length; i++) {
            refunds.push(Refund(amounts[i], recipients[i]));
        }
    }

    /// @dev Executes the full refund flow (same logic as HypERC20CollateralRefund.s.sol)
    function _executeRefund() internal {
        Router oldRouter = Router(OLD_ROUTER);
        address prevIsm = address(oldRouter.interchainSecurityModule());

        vm.startPrank(SAFE);

        // 1. Deploy TrustedRelayerIsm via CREATE2
        bytes32 salt = keccak256(
            abi.encode("refund", OLD_ROUTER, REMOTE_DOMAIN)
        );
        (bool ok, bytes memory res) = CREATE2_FACTORY.call(
            abi.encodePacked(
                salt,
                type(TrustedRelayerIsm).creationCode,
                abi.encode(MAILBOX_ADDR, SAFE)
            )
        );
        require(ok, "CREATE2 failed");
        address ism = address(bytes20(res));

        // 2. Set permissive ISM
        oldRouter.setInterchainSecurityModule(ism);

        // 3. Process spoofed messages to refund each depositor
        uint32 localDomain = mailbox.localDomain();
        for (uint256 i = 0; i < refunds.length; i++) {
            bytes memory body = abi.encodePacked(
                refunds[i].recipient.addressToBytes32(),
                refunds[i].amount
            );
            bytes memory message = abi.encodePacked(
                MAILBOX_VERSION,
                uint32(type(uint32).max - i),
                REMOTE_DOMAIN,
                remoteRouter,
                localDomain,
                OLD_ROUTER.addressToBytes32(),
                body
            );
            mailbox.process("", message);
        }

        // 4. Restore previous ISM
        oldRouter.setInterchainSecurityModule(prevIsm);

        vm.stopPrank();
    }

    function test_refundDepositors() public {
        // Snapshot pre-state
        uint256[] memory preBals = new uint256[](refunds.length);
        uint256 totalRefund;
        for (uint256 i = 0; i < refunds.length; i++) {
            preBals[i] = usdc.balanceOf(refunds[i].recipient);
            totalRefund += refunds[i].amount;
        }
        uint256 preRouterBal = usdc.balanceOf(OLD_ROUTER);
        address preIsm = address(Router(OLD_ROUTER).interchainSecurityModule());

        assertGe(preRouterBal, totalRefund, "Router has insufficient USDC");

        _executeRefund();

        // Verify each depositor received the correct amount
        for (uint256 i = 0; i < refunds.length; i++) {
            assertEq(
                usdc.balanceOf(refunds[i].recipient),
                preBals[i] + refunds[i].amount,
                string.concat("Depositor ", vm.toString(i), " balance wrong")
            );
        }

        // Verify router balance decreased by exactly the total refund
        assertEq(
            usdc.balanceOf(OLD_ROUTER),
            preRouterBal - totalRefund,
            "Router balance mismatch"
        );

        // Verify ISM restored to original
        assertEq(
            address(Router(OLD_ROUTER).interchainSecurityModule()),
            preIsm,
            "ISM not restored"
        );

        // Verify owner unchanged
        assertEq(Router(OLD_ROUTER).owner(), SAFE, "Owner changed");

        // Verify remote routers still enrolled
        assertNotEq(
            Router(OLD_ROUTER).routers(42161),
            bytes32(0),
            "Arbitrum router unenrolled"
        );
        assertNotEq(
            Router(OLD_ROUTER).routers(8453),
            bytes32(0),
            "Base router unenrolled"
        );
    }

    /// @dev Sanity check: verify dynamically-fetched refunds.json matches
    ///      the known on-chain data from the 4 stuck transactions.
    function test_refundsMatchExpected() public {
        // Known depositors and amounts from the original stuck txs
        address[4] memory expectedRecipients = [
            0x71E91e35C770b4fB56F419aDa46CF5348530D26d,
            0x6af58cED7d0E5162aAe77aA05B7Eb6CB026EF60b,
            0x5D0A4B19371f18d98d8ae135655ea8e12D7827E2,
            0xD0F6c33de5Ab51301845b75835A1AE0d9F6AD294
        ];
        uint256[4] memory expectedAmounts = [
            uint256(988834),
            uint256(3725000000),
            uint256(99959241),
            uint256(1000)
        ];

        assertEq(refunds.length, 4, "Expected 4 refunds");

        for (uint256 i = 0; i < 4; i++) {
            assertEq(
                refunds[i].recipient,
                expectedRecipients[i],
                string.concat("Recipient mismatch at index ", vm.toString(i))
            );
            assertEq(
                refunds[i].amount,
                expectedAmounts[i],
                string.concat("Amount mismatch at index ", vm.toString(i))
            );
        }
    }

    function test_cannotReplayRefund() public {
        _executeRefund();

        // Try replaying: CREATE2 with same salt should fail (contract exists)
        bytes32 salt = keccak256(
            abi.encode("refund", OLD_ROUTER, REMOTE_DOMAIN)
        );
        vm.prank(SAFE);
        (bool ok, ) = CREATE2_FACTORY.call(
            abi.encodePacked(
                salt,
                type(TrustedRelayerIsm).creationCode,
                abi.encode(MAILBOX_ADDR, SAFE)
            )
        );
        assertFalse(ok, "CREATE2 replay should fail");
    }

    function test_noValueTransferred() public {
        uint256 preSafeEth = SAFE.balance;

        _executeRefund();

        assertEq(SAFE.balance, preSafeEth, "ETH was unexpectedly transferred");
    }

    function test_onlyUsdcMoved() public {
        uint256 preMailboxBal = usdc.balanceOf(MAILBOX_ADDR);
        uint256 preSafeBal = usdc.balanceOf(SAFE);

        _executeRefund();

        assertEq(
            usdc.balanceOf(MAILBOX_ADDR),
            preMailboxBal,
            "Mailbox USDC changed"
        );
        assertEq(usdc.balanceOf(SAFE), preSafeBal, "Safe USDC changed");
    }
}
