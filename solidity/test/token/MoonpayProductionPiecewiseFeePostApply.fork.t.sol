// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Quote} from "contracts/interfaces/ITokenBridge.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {CrossCollateralRouter} from "contracts/token/CrossCollateralRouter.sol";
import {CrossCollateralRoutingFee} from "contracts/token/CrossCollateralRoutingFee.sol";
import {FeeType} from "contracts/token/fees/BaseFee.sol";
import {OffchainQuotedPiecewiseLinearFee} from "contracts/token/fees/OffchainQuotedPiecewiseLinearFee.sol";

/// @dev Attach-only verifier for a local BSC fork after the production warp
/// apply has completed. It never deploys or reconfigures the fee topology.
contract MoonpayProductionPiecewiseFeePostApplyForkTest is Test {
    using TypeCasts for address;

    address internal constant BSC_USDT_ROUTER =
        0x050dcc964BCA53eF1A98A2347995cabC73cE25b9;
    address internal constant BSC_USDT =
        0x55d398326f99059fF775485246999027B3197955;
    address internal constant EXPECTED_FEE_ROOT =
        0x4c61a80406ee56DC3F1B92872895fD6Be7850741;
    address internal constant FEE_OWNER =
        0xA0e41Ab972294A8f7CD1599BB76AdDB6bAE24556;
    address internal constant QUOTE_SIGNER_ONE =
        0xEd1829805De615eEFC7303766D395Ea0a1B2b04d;
    address internal constant QUOTE_SIGNER_TWO =
        0x6bb7818bbE8d88094Cf3620e58BC6BbEd542B867;
    address internal constant USER = address(0xBEEF);

    uint256 internal constant TRANSFER_AMOUNT = 5e18;
    uint256 internal constant EXPECTED_FEE = 0.0075e18;
    uint32 internal constant EXPECTED_MARGINAL_BPS_X1E4 = 150_000;

    CrossCollateralRouter internal router;
    CrossCollateralRoutingFee internal feeRoot;
    IERC20 internal usdt;

    function setUp() public {
        if (!vm.envOr("RUN_MOONPAY_PRODUCTION_POST_APPLY", false)) {
            vm.skip(true);
        }

        vm.createSelectFork(vm.envString("RPC_URL_BSC"));

        router = CrossCollateralRouter(BSC_USDT_ROUTER);
        assertEq(router.token(), BSC_USDT, "unexpected BSC USDT token");
        assertEq(
            router.feeRecipient(),
            EXPECTED_FEE_ROOT,
            "unexpected production fee root"
        );

        usdt = IERC20(BSC_USDT);
        feeRoot = CrossCollateralRoutingFee(EXPECTED_FEE_ROOT);
        assertEq(feeRoot.owner(), FEE_OWNER, "unexpected fee root owner");
        assertEq(
            uint256(feeRoot.feeType()),
            uint256(FeeType.CROSS_COLLATERAL_ROUTING),
            "unexpected fee root type"
        );
    }

    function testFork_postApplyProductionBscUsdtPiecewiseFees() public {
        (uint32[] memory domains, bytes32[] memory targets) = _lanes();
        address[] memory leaves = new address[](domains.length);
        bytes32 recipient = USER.addressToBytes32();

        for (uint256 i = 0; i < domains.length; ++i) {
            leaves[i] = _assertPiecewiseLeaf(domains[i], targets[i]);

            for (uint256 j = 0; j < i; ++j) {
                assertNotEq(
                    leaves[i],
                    leaves[j],
                    "piecewise leaf reused across lanes"
                );
            }

            _assertFiveUsdtQuote(domains[i], recipient, targets[i]);
        }

        _assertArbitrumDispatch(recipient, domains[0], targets[0], leaves[0]);
    }

    function _assertPiecewiseLeaf(
        uint32 domain,
        bytes32 target
    ) internal view returns (address leafAddress) {
        assertTrue(
            router.crossCollateralRouters(domain, target),
            "USDC target router is not enrolled"
        );

        leafAddress = feeRoot.feeContracts(domain, target);
        assertNotEq(leafAddress, address(0), "missing piecewise leaf");
        assertGt(leafAddress.code.length, 0, "piecewise leaf has no code");

        OffchainQuotedPiecewiseLinearFee leaf = OffchainQuotedPiecewiseLinearFee(
                payable(leafAddress)
            );
        assertEq(
            uint256(leaf.feeType()),
            uint256(FeeType.OFFCHAIN_QUOTED_PIECEWISE_LINEAR),
            "unexpected leaf type"
        );
        assertEq(leaf.owner(), FEE_OWNER, "unexpected leaf owner");
        assertEq(address(leaf.token()), BSC_USDT, "unexpected leaf token");
        assertEq(leaf.maxBands(), 4, "unexpected max bands");

        address[] memory signers = leaf.quoteSigners();
        assertEq(signers.length, 2, "unexpected quote signer count");
        assertTrue(
            leaf.isQuoteSigner(QUOTE_SIGNER_ONE),
            "first quote signer missing"
        );
        assertTrue(
            leaf.isQuoteSigner(QUOTE_SIGNER_TWO),
            "second quote signer missing"
        );

        OffchainQuotedPiecewiseLinearFee.FallbackCurve
            memory fallbackCurve = leaf.getFallbackCurve();
        assertEq(fallbackCurve.breakpoints.length, 0, "fallback is not flat");
        assertEq(
            fallbackCurve.marginalBpsX1e4.length,
            1,
            "unexpected fallback band count"
        );
        assertEq(
            fallbackCurve.marginalBpsX1e4[0],
            EXPECTED_MARGINAL_BPS_X1E4,
            "unexpected fallback bps"
        );
    }

    function _assertFiveUsdtQuote(
        uint32 domain,
        bytes32 recipient,
        bytes32 target
    ) internal view {
        Quote[] memory rootQuotes = feeRoot.quoteTransferRemoteTo(
            domain,
            recipient,
            TRANSFER_AMOUNT,
            target
        );
        assertEq(rootQuotes.length, 1, "unexpected root quote count");
        assertEq(rootQuotes[0].token, BSC_USDT, "unexpected root quote token");
        assertEq(rootQuotes[0].amount, EXPECTED_FEE, "unexpected root quote");

        Quote[] memory routerQuotes = router.quoteTransferRemoteTo(
            domain,
            recipient,
            TRANSFER_AMOUNT,
            target
        );
        assertEq(routerQuotes.length, 3, "unexpected router quote count");
        assertEq(
            routerQuotes[1].token,
            BSC_USDT,
            "unexpected router fee token"
        );
        assertEq(
            routerQuotes[1].amount,
            TRANSFER_AMOUNT + EXPECTED_FEE,
            "unexpected router token quote"
        );
    }

    function _assertArbitrumDispatch(
        bytes32 recipient,
        uint32 domain,
        bytes32 target,
        address leaf
    ) internal {
        Quote[] memory quotes = router.quoteTransferRemoteTo(
            domain,
            recipient,
            TRANSFER_AMOUNT,
            target
        );
        uint256 tokenDebit = quotes[1].amount + quotes[2].amount;
        if (quotes[0].token == BSC_USDT) tokenDebit += quotes[0].amount;

        deal(BSC_USDT, USER, tokenDebit);
        vm.deal(USER, 100 ether);

        uint256 rootBalanceBefore = usdt.balanceOf(address(feeRoot));
        assertEq(usdt.balanceOf(leaf), 0, "piecewise leaf holds USDT");
        vm.startPrank(USER);
        usdt.approve(address(router), tokenDebit);
        router.transferRemoteTo{
            value: quotes[0].token == address(0) ? quotes[0].amount : 0
        }(domain, recipient, TRANSFER_AMOUNT, target);
        vm.stopPrank();

        assertEq(
            usdt.balanceOf(address(feeRoot)) - rootBalanceBefore,
            EXPECTED_FEE,
            "unexpected fee root balance delta"
        );
        assertEq(usdt.balanceOf(leaf), 0, "fee accrued to piecewise leaf");
    }

    function _lanes()
        internal
        pure
        returns (uint32[] memory domains, bytes32[] memory targets)
    {
        domains = new uint32[](7);
        targets = new bytes32[](7);

        domains[0] = 42161;
        targets[0] = 0xeBC079D41C41a0ef7e54aa7Af867df9a621C9bE0
            .addressToBytes32();
        domains[1] = 8453;
        targets[1] = 0x253821543C24623ecD3ceBCEd704359AF16CF38f
            .addressToBytes32();
        domains[2] = 4114;
        targets[2] = 0x2bef59e84615371304bd731601f6344F5F304504
            .addressToBytes32();
        domains[3] = 1;
        targets[3] = 0xA9C9a8FB36Ce3e5ffBAC3757dA7141262723541F
            .addressToBytes32();
        domains[4] = 747474;
        targets[4] = 0x936e8A1fBD8317Be59A9B8924a300993c8Bf7ce6
            .addressToBytes32();
        domains[5] = 137;
        targets[5] = 0x28a96f9928dB06317356caACd5641C4Fde4424C7
            .addressToBytes32();
        domains[6] = 1399811149;
        targets[6] = bytes32(
            (uint256(uint128(0xf5324d5c5be7eb842fb738d13de87ee3)) << 128) |
                uint256(uint128(0x9cb9b6629ea6566c14241cd27a9b788b))
        );
    }
}
