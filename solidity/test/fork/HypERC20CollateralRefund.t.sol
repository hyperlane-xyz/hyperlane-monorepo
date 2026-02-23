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
 *         Reads refund data from REFUND_RECIPIENT and REFUND_AMOUNT env vars
 *         (set by refund-pipeline.sh).
 *
 *         Run: REFUND_RECIPIENT=0x... REFUND_AMOUNT=3825949075 \
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

    IERC20 usdc;
    IMailbox mailbox;
    bytes32 remoteRouter;
    address refundRecipient;
    uint256 refundAmount;

    function setUp() public {
        // Skip if not on a fork (handles CI without fork URL)
        vm.skip(OLD_ROUTER.code.length == 0);

        usdc = IERC20(USDC);
        mailbox = IMailbox(MAILBOX_ADDR);
        remoteRouter = Router(OLD_ROUTER).routers(REMOTE_DOMAIN);
        vm.deal(SAFE, 1 ether);

        // Load refund data from env vars (set by refund-pipeline.sh)
        refundRecipient = vm.envAddress("REFUND_RECIPIENT");
        refundAmount = vm.envUint("REFUND_AMOUNT");
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

        // 3. Process spoofed message to refund recipient
        bytes memory body = abi.encodePacked(
            refundRecipient.addressToBytes32(),
            refundAmount
        );
        bytes memory message = abi.encodePacked(
            MAILBOX_VERSION,
            uint32(type(uint32).max),
            REMOTE_DOMAIN,
            remoteRouter,
            mailbox.localDomain(),
            OLD_ROUTER.addressToBytes32(),
            body
        );
        mailbox.process("", message);

        // 4. Restore previous ISM
        oldRouter.setInterchainSecurityModule(prevIsm);

        // 5. Unenroll all remote routers
        uint32[] memory domains = oldRouter.domains();
        oldRouter.unenrollRemoteRouters(domains);

        vm.stopPrank();
    }

    function test_refundRecipient() public {
        uint256 preBal = usdc.balanceOf(refundRecipient);
        uint256 preRouterBal = usdc.balanceOf(OLD_ROUTER);
        address preIsm = address(Router(OLD_ROUTER).interchainSecurityModule());

        assertGe(preRouterBal, refundAmount, "Router has insufficient USDC");

        _executeRefund();

        // Verify recipient received the correct amount
        assertEq(
            usdc.balanceOf(refundRecipient),
            preBal + refundAmount,
            "Recipient balance wrong"
        );

        // Verify router balance decreased by exactly the refund amount
        assertEq(
            usdc.balanceOf(OLD_ROUTER),
            preRouterBal - refundAmount,
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

        // Verify all remote routers unenrolled
        assertEq(
            Router(OLD_ROUTER).routers(42161),
            bytes32(0),
            "Arbitrum router not unenrolled"
        );
        assertEq(
            Router(OLD_ROUTER).routers(8453),
            bytes32(0),
            "Base router not unenrolled"
        );
        assertEq(
            Router(OLD_ROUTER).routers(10),
            bytes32(0),
            "Optimism router not unenrolled"
        );
        assertEq(
            Router(OLD_ROUTER).routers(1),
            bytes32(0),
            "Ethereum router not unenrolled"
        );
        assertEq(
            Router(OLD_ROUTER).routers(5330),
            bytes32(0),
            "Superseed router not unenrolled"
        );
        assertEq(
            Router(OLD_ROUTER).routers(1399811149),
            bytes32(0),
            "Solana router not unenrolled"
        );
    }

    /// @dev Sanity check: verify dynamically-fetched total matches
    ///      the known on-chain amounts from the 4 stuck transactions.
    function test_refundAmountMatchesExpected() public {
        // Known amounts from the original stuck txs
        uint256 expectedTotal = 988834 + 3725000000 + 99959241 + 1000; // 3825949075
        assertEq(refundAmount, expectedTotal, "Total amount mismatch");
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

    function test_allRoutersUnenrolled() public {
        // Verify routers are enrolled before
        assertNotEq(
            Router(OLD_ROUTER).routers(42161),
            bytes32(0),
            "Arbitrum should be enrolled before"
        );

        _executeRefund();

        // Verify all domains unenrolled
        uint32[] memory domains = Router(OLD_ROUTER).domains();
        assertEq(domains.length, 0, "Should have no enrolled domains");
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
