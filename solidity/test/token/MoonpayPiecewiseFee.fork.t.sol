// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {SignedQuote} from "contracts/interfaces/IOffchainQuoter.sol";
import {Quote} from "contracts/interfaces/ITokenBridge.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {CrossCollateralRouter} from "contracts/token/CrossCollateralRouter.sol";
import {CrossCollateralRoutingFee} from "contracts/token/CrossCollateralRoutingFee.sol";
import {OffchainQuotedLinearFee, FeeQuoteContext} from "contracts/token/fees/OffchainQuotedLinearFee.sol";
import {OffchainQuotedPiecewiseLinearFee} from "contracts/token/fees/OffchainQuotedPiecewiseLinearFee.sol";

contract MoonpayPiecewiseFeeForkTest is Test {
    using TypeCasts for address;

    uint32 internal constant ARBITRUM_DOMAIN = 42161;
    address internal constant BSC_USDT_ROUTER =
        0xaC9e83a1bDbC86a26aDf331785d3CaCF18963a6C;
    address internal constant ARBITRUM_USDC_ROUTER =
        0x9fb176528AdF0Bb7524CE752B2345C80eD24243F;
    address internal constant DEPLOYER =
        0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba;
    address internal constant USER = address(0xBEEF);

    uint256 internal constant QUOTE_SIGNER_PK = 0xA11CE;
    uint256 internal constant TRANSFER_AMOUNT = 1e18;
    uint256 internal constant FIRST_BREAKPOINT = 250_000_000_000_000_000;
    uint256 internal constant SECOND_BREAKPOINT = 750_000_000_000_000_000;

    CrossCollateralRouter internal router;
    IERC20 internal usdt;
    CrossCollateralRoutingFee internal routingFee;
    OffchainQuotedLinearFee internal defaultFee;
    OffchainQuotedPiecewiseLinearFee internal piecewiseFee;

    function setUp() public {
        string memory rpc = vm.envOr(
            "RPC_URL_BSC",
            string("https://bsc.blockrazor.xyz")
        );
        vm.createSelectFork(rpc);

        router = CrossCollateralRouter(BSC_USDT_ROUTER);
        assertEq(router.owner(), DEPLOYER, "unexpected staging router owner");
        usdt = IERC20(router.token());
        assertTrue(
            router.crossCollateralRouters(
                ARBITRUM_DOMAIN,
                ARBITRUM_USDC_ROUTER.addressToBytes32()
            ),
            "Arbitrum USDC target is not enrolled"
        );

        defaultFee = new OffchainQuotedLinearFee(
            vm.addr(QUOTE_SIGNER_PK),
            address(usdt),
            6e32,
            1e36,
            address(this)
        );

        uint128[] memory breakpoints = new uint128[](2);
        breakpoints[0] = uint128(FIRST_BREAKPOINT);
        breakpoints[1] = uint128(SECOND_BREAKPOINT);
        uint32[] memory fallbackRates = new uint32[](3);
        fallbackRates[0] = 40_000; // 4 bps
        fallbackRates[1] = 100_000; // 10 bps
        fallbackRates[2] = 200_000; // 20 bps
        piecewiseFee = new OffchainQuotedPiecewiseLinearFee(
            vm.addr(QUOTE_SIGNER_PK),
            address(usdt),
            breakpoints,
            fallbackRates,
            5,
            address(this)
        );

        routingFee = new CrossCollateralRoutingFee(address(this));
        uint32[] memory destinations = new uint32[](2);
        destinations[0] = ARBITRUM_DOMAIN;
        destinations[1] = ARBITRUM_DOMAIN;
        bytes32[] memory targetRouters = new bytes32[](2);
        targetRouters[0] = routingFee.DEFAULT_ROUTER();
        targetRouters[1] = ARBITRUM_USDC_ROUTER.addressToBytes32();
        address[] memory feeContracts = new address[](2);
        feeContracts[0] = address(defaultFee);
        feeContracts[1] = address(piecewiseFee);
        routingFee.setCrossCollateralRouterFeeContracts(
            destinations,
            targetRouters,
            feeContracts
        );

        vm.prank(DEPLOYER);
        router.setFeeRecipient(address(routingFee));
    }

    function testFork_stagingBscUsdtArbitrumUsdcLifecycle() public {
        bytes32 targetRouter = ARBITRUM_USDC_ROUTER.addressToBytes32();
        bytes32 recipient = USER.addressToBytes32();

        assertEq(router.feeRecipient(), address(routingFee));
        assertGt(TRANSFER_AMOUNT, SECOND_BREAKPOINT, "must cross all bands");
        assertEq(
            _targetFee(recipient, targetRouter),
            1_100_000_000_000_000,
            "weighted fallback fee"
        );

        uint48 issuedAt = uint48(block.timestamp);
        _submitStandingCurve(issuedAt, issuedAt + 60);
        assertEq(
            _targetFee(recipient, targetRouter),
            650_000_000_000_000,
            "weighted fresh fee"
        );

        _assertFreshTransferChargesRoutingRoot(recipient, targetRouter);

        vm.warp(issuedAt + 12);
        assertEq(
            _targetFee(recipient, targetRouter),
            1_100_000_000_000_000,
            "weighted stale fee"
        );

        vm.warp(issuedAt + 61);
        assertEq(
            _targetFee(recipient, targetRouter),
            1_100_000_000_000_000,
            "weighted expired fallback"
        );

        Quote[] memory primaryQuotes = router.quoteTransferRemote(
            ARBITRUM_DOMAIN,
            recipient,
            TRANSFER_AMOUNT
        );
        assertEq(
            primaryQuotes[1].amount - TRANSFER_AMOUNT,
            300_000_000_000_000,
            "primary USDT route uses 3 bps default"
        );
    }

    function _targetFee(
        bytes32 recipient,
        bytes32 targetRouter
    ) internal view returns (uint256) {
        Quote[] memory quotes = router.quoteTransferRemoteTo(
            ARBITRUM_DOMAIN,
            recipient,
            TRANSFER_AMOUNT,
            targetRouter
        );
        return quotes[1].amount - TRANSFER_AMOUNT;
    }

    function _assertFreshTransferChargesRoutingRoot(
        bytes32 recipient,
        bytes32 targetRouter
    ) internal {
        Quote[] memory quotes = router.quoteTransferRemoteTo(
            ARBITRUM_DOMAIN,
            recipient,
            TRANSFER_AMOUNT,
            targetRouter
        );
        uint256 tokenCharge = quotes[1].amount + quotes[2].amount;
        if (quotes[0].token == address(usdt)) tokenCharge += quotes[0].amount;

        deal(address(usdt), USER, tokenCharge);
        vm.deal(USER, 10 ether);
        vm.startPrank(USER);
        usdt.approve(address(router), tokenCharge);
        router.transferRemoteTo{
            value: quotes[0].token == address(0) ? quotes[0].amount : 0
        }(ARBITRUM_DOMAIN, recipient, TRANSFER_AMOUNT, targetRouter);
        vm.stopPrank();

        assertEq(usdt.balanceOf(address(routingFee)), 650_000_000_000_000);
        assertEq(usdt.balanceOf(address(piecewiseFee)), 0);
    }

    function _submitStandingCurve(uint48 issuedAt, uint48 expiry) internal {
        uint128[] memory breakpoints = new uint128[](2);
        breakpoints[0] = uint128(FIRST_BREAKPOINT);
        breakpoints[1] = uint128(SECOND_BREAKPOINT);
        uint32[] memory freshRates = new uint32[](3);
        freshRates[0] = 20_000; // 2 bps
        freshRates[1] = 60_000; // 6 bps
        freshRates[2] = 120_000; // 12 bps
        uint32[] memory staleSurcharges = new uint32[](3);
        staleSurcharges[0] = 20_000; // +2 bps
        staleSurcharges[1] = 40_000; // +4 bps
        staleSurcharges[2] = 80_000; // +8 bps

        SignedQuote memory quote = SignedQuote({
            context: FeeQuoteContext.encode(
                ARBITRUM_DOMAIN,
                bytes32(type(uint256).max),
                type(uint256).max
            ),
            data: abi.encode(
                breakpoints,
                freshRates,
                uint32(12),
                staleSurcharges
            ),
            issuedAt: issuedAt,
            expiry: expiry,
            salt: bytes32(0),
            submitter: address(this)
        });

        bytes32 structHash = keccak256(
            abi.encode(
                piecewiseFee.SIGNED_QUOTE_TYPEHASH(),
                keccak256(quote.context),
                keccak256(quote.data),
                quote.issuedAt,
                quote.expiry,
                quote.salt,
                quote.submitter
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("OffchainQuoter"),
                keccak256("1"),
                block.chainid,
                address(piecewiseFee)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            QUOTE_SIGNER_PK,
            ECDSA.toTypedDataHash(domainSeparator, structHash)
        );
        piecewiseFee.submitQuote(quote, abi.encodePacked(r, s, v));
    }
}
