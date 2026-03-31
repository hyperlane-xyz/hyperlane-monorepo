// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {InterchainGasPaymaster} from "../../contracts/hooks/igp/InterchainGasPaymaster.sol";
import {StorageGasOracle} from "../../contracts/hooks/igp/StorageGasOracle.sol";
import {IGasOracle} from "../../contracts/interfaces/IGasOracle.sol";

import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {GasRouter} from "../../contracts/client/GasRouter.sol";
import {LinearFee} from "../../contracts/token/fees/LinearFee.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * @title ScaledFeeConsistencyTest
 * @notice Tests that fee arithmetic remains consistent in local scale
 *         when a warp route has non-1:1 scaling (e.g., 6 -> 18 decimals).
 *
 *         The concern: _quoteGasPayment internally builds a message with
 *         _outboundAmount (scaled), so hook fees could be proportional to
 *         the scaled amount. But feeAmount from the fee recipient is in
 *         local scale. Adding them in _calculateFeesAndCharge must not
 *         produce a scale mismatch.
 */
contract ScaledFeeConsistencyTest is Test {
    using TypeCasts for address;

    uint32 internal constant ORIGIN = 1;
    uint32 internal constant DESTINATION = 2;

    // Simulate a 6-decimal local token scaling to 18-decimal outbound
    // scaleNumerator=1e18, scaleDenominator=1e6 => outbound = local * 1e12
    uint256 internal constant SCALE_NUMERATOR = 1e18;
    uint256 internal constant SCALE_DENOMINATOR = 1e6;

    uint8 internal constant LOCAL_DECIMALS = 6;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e6; // 1M tokens in 6-decimal
    uint256 internal constant TRANSFER_AMT = 100e6; // 100 tokens in 6-decimal
    uint256 internal constant GAS_LIMIT = 50_000;
    uint128 internal constant GAS_PRICE = 10;
    uint96 internal constant GAS_OVERHEAD = 10_000;
    uint128 internal constant TOKEN_EXCHANGE_RATE = 1e10;

    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    address internal constant PROXY_ADMIN = address(0x37);

    ERC20Test internal localErc20;
    HypERC20Collateral internal localRouter;
    HypERC20 internal remoteRouter;
    MockMailbox internal originMailbox;
    MockMailbox internal destMailbox;
    TestPostDispatchHook internal noopHook;
    InterchainGasPaymaster internal igp;
    StorageGasOracle internal gasOracle;
    LinearFee internal feeContract;

    function setUp() public {
        // Deploy mailboxes
        originMailbox = new MockMailbox(ORIGIN);
        destMailbox = new MockMailbox(DESTINATION);
        originMailbox.addRemoteMailbox(DESTINATION, destMailbox);
        destMailbox.addRemoteMailbox(ORIGIN, originMailbox);

        // Deploy 6-decimal ERC20
        localErc20 = new ERC20Test("USDC", "USDC", TOTAL_SUPPLY, LOCAL_DECIMALS);

        // Deploy hooks
        noopHook = new TestPostDispatchHook();
        originMailbox.setDefaultHook(address(noopHook));
        originMailbox.setRequiredHook(address(noopHook));
        destMailbox.setDefaultHook(address(noopHook));
        destMailbox.setRequiredHook(address(noopHook));

        // Deploy IGP
        igp = new InterchainGasPaymaster();
        igp.initialize(address(this), address(this));

        gasOracle = new StorageGasOracle();
        gasOracle.setRemoteGasData(
            StorageGasOracle.RemoteGasDataConfig({
                remoteDomain: DESTINATION,
                tokenExchangeRate: TOKEN_EXCHANGE_RATE,
                gasPrice: GAS_PRICE
            })
        );

        InterchainGasPaymaster.GasParam[]
            memory gasParams = new InterchainGasPaymaster.GasParam[](1);
        gasParams[0] = InterchainGasPaymaster.GasParam({
            remoteDomain: DESTINATION,
            config: InterchainGasPaymaster.DomainGasConfig({
                gasOracle: gasOracle,
                gasOverhead: GAS_OVERHEAD
            })
        });
        igp.setDestinationGasConfigs(gasParams);

        // Deploy scaled collateral router (6 -> 18 decimals)
        localRouter = new HypERC20Collateral(
            address(localErc20),
            SCALE_NUMERATOR,
            SCALE_DENOMINATOR,
            address(originMailbox)
        );
        localRouter.initialize(
            address(noopHook),
            address(0),
            address(this)
        );

        // Deploy remote synthetic (18-decimal)
        HypERC20 remoteImpl = new HypERC20(
            18,
            1,
            1,
            address(destMailbox)
        );
        TransparentUpgradeableProxy remoteProxy = new TransparentUpgradeableProxy(
            address(remoteImpl),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20.initialize.selector,
                0,
                "Remote USDC",
                "rUSDC",
                address(noopHook),
                address(0),
                address(this)
            )
        );
        remoteRouter = HypERC20(address(remoteProxy));

        // Enroll routers
        localRouter.enrollRemoteRouter(
            DESTINATION,
            address(remoteRouter).addressToBytes32()
        );
        remoteRouter.enrollRemoteRouter(
            ORIGIN,
            address(localRouter).addressToBytes32()
        );

        // Set destination gas
        GasRouter.GasRouterConfig[]
            memory gasConfigs = new GasRouter.GasRouterConfig[](1);
        gasConfigs[0] = GasRouter.GasRouterConfig({
            domain: DESTINATION,
            gas: GAS_LIMIT
        });
        localRouter.setDestinationGas(gasConfigs);

        // Deploy fee recipient (LinearFee) - charges fees in local token
        // maxFee=1e6 (1 token in 6-decimal), halfAmount=100e6
        feeContract = new LinearFee(
            address(localErc20),
            1e6,
            100e6,
            address(this)
        );
        localRouter.setFeeRecipient(address(feeContract));

        // Configure ERC20 IGP for localErc20 token
        _setTokenGasConfig(address(localErc20), DESTINATION, gasOracle);

        // Set fee hook (enables ERC20 gas payments via token())
        localRouter.setFeeHook(address(igp));
        localRouter.setHook(address(igp));

        // Fund ALICE
        localErc20.transfer(ALICE, TOTAL_SUPPLY / 2);
        localErc20.transfer(address(localRouter), TOTAL_SUPPLY / 4); // collateral
    }

    // ============ Core Tests ============

    /// @notice Verify quoteTransferRemote returns all fees in local (6-decimal) scale
    function test_quoteTransferRemote_feesInLocalScale() public view {
        Quote[] memory quotes = localRouter.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        // quotes[0] = hook/gas fee (in token() which is localErc20)
        uint256 hookFee = quotes[0].amount;
        // quotes[1] = amount + feeRecipient fee (in token())
        uint256 amountPlusFee = quotes[1].amount;
        // quotes[2] = external fee
        uint256 externalFee = quotes[2].amount;

        // All quote tokens should be localErc20 (6-decimal token)
        assertEq(quotes[0].token, address(localErc20), "hookFee token mismatch");
        assertEq(quotes[1].token, address(localErc20), "amountPlusFee token mismatch");
        assertEq(quotes[2].token, address(localErc20), "externalFee token mismatch");

        // The fee recipient fee should be reasonable relative to local scale
        uint256 feeRecipientFee = amountPlusFee - TRANSFER_AMT;
        assertGt(feeRecipientFee, 0, "feeRecipientFee should be > 0");
        // LinearFee: fee = amount * maxFee / (2 * halfAmount) capped at maxFee
        // = 100e6 * 1e6 / (2 * 100e6) = 500000 (0.5 tokens in 6-decimal)
        assertEq(feeRecipientFee, 500000, "feeRecipientFee unexpected value");

        // hookFee should be > 0 (IGP charges gas)
        assertGt(hookFee, 0, "hookFee should be > 0");

        // Critical check: hookFee should be in local (6-decimal) scale.
        // If hookFee were accidentally in 18-decimal scale, it would be ~1e12x larger.
        // The IGP fee = gasPrice * totalGas * exchangeRate / 1e10
        // totalGas = GAS_LIMIT + GAS_OVERHEAD = 60000
        // fee = 10 * 60000 * 1e10 / 1e10 = 600000
        // This is 0.6 tokens in 6-decimal scale, which is reasonable
        assertLt(hookFee, 10e6, "hookFee suspiciously large - possible scale mismatch");

        // Total charge should be sum of all fees + transfer amount
        uint256 totalCharge = hookFee + amountPlusFee + externalFee;
        assertLt(totalCharge, TOTAL_SUPPLY, "total charge exceeds supply - scale issue");
    }

    /// @notice Verify transferRemote succeeds with exactly the quoted amounts
    function test_transferRemote_succeedsWithExactQuote() public {
        Quote[] memory quotes = localRouter.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        uint256 hookFee = quotes[0].amount;
        uint256 amountPlusFee = quotes[1].amount;
        uint256 externalFee = quotes[2].amount;

        // Total ERC20 tokens ALICE needs to approve:
        // For collateral router, charge = amount + feeRecipientFee + externalFee + hookFee
        uint256 totalApproval = amountPlusFee + externalFee + hookFee;

        vm.startPrank(ALICE);
        localErc20.approve(address(localRouter), totalApproval);

        uint256 aliceBefore = localErc20.balanceOf(ALICE);

        // transferRemote with msg.value=0 (ERC20 IGP)
        localRouter.transferRemote{value: 0}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        vm.stopPrank();

        uint256 aliceAfter = localErc20.balanceOf(ALICE);
        uint256 actualCharge = aliceBefore - aliceAfter;

        // The actual charge should equal the quoted total
        assertEq(
            actualCharge,
            totalApproval,
            "actual charge != quoted total - scale inconsistency"
        );
    }

    /// @notice Verify that fee recipient receives fees in local scale
    function test_transferRemote_feeRecipientReceivesLocalScaleFee() public {
        Quote[] memory quotes = localRouter.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        uint256 hookFee = quotes[0].amount;
        uint256 amountPlusFee = quotes[1].amount;
        uint256 externalFee = quotes[2].amount;
        uint256 feeRecipientFee = amountPlusFee - TRANSFER_AMT;

        uint256 totalApproval = amountPlusFee + externalFee + hookFee;

        uint256 feeRecipientBefore = localErc20.balanceOf(address(feeContract));
        uint256 igpBefore = localErc20.balanceOf(address(igp));

        vm.startPrank(ALICE);
        localErc20.approve(address(localRouter), totalApproval);
        localRouter.transferRemote{value: 0}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        vm.stopPrank();

        // Fee recipient should receive exactly the quoted fee (in local 6-decimal scale)
        uint256 feeRecipientAfter = localErc20.balanceOf(address(feeContract));
        assertEq(
            feeRecipientAfter - feeRecipientBefore,
            feeRecipientFee,
            "feeRecipient received wrong amount"
        );

        // IGP should receive exactly the hook fee (in local 6-decimal scale)
        uint256 igpAfter = localErc20.balanceOf(address(igp));
        assertEq(
            igpAfter - igpBefore,
            hookFee,
            "IGP received wrong amount"
        );
    }

    /// @notice Verify quote-then-transfer roundtrip: no over/undercharge
    function test_transferRemote_noOverOrUnderCharge() public {
        Quote[] memory quotes = localRouter.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        uint256 hookFee = quotes[0].amount;
        uint256 amountPlusFee = quotes[1].amount;
        uint256 externalFee = quotes[2].amount;
        uint256 totalQuoted = hookFee + amountPlusFee + externalFee;

        // Approve exactly the quoted amount - should not revert
        vm.startPrank(ALICE);
        localErc20.approve(address(localRouter), totalQuoted);

        uint256 aliceBefore = localErc20.balanceOf(ALICE);
        localRouter.transferRemote{value: 0}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        vm.stopPrank();

        // Verify exact match - no dust left, no extra charged
        assertEq(
            aliceBefore - localErc20.balanceOf(ALICE),
            totalQuoted,
            "charge != quote - scale mismatch causes over/undercharge"
        );
    }

    /// @notice Verify with a different transfer amount to ensure fee scaling is consistent
    function test_transferRemote_variousAmounts_feeScaleConsistent() public {
        uint256[] memory amounts = new uint256[](4);
        amounts[0] = 1e6;       // 1 token
        amounts[1] = 50e6;      // 50 tokens
        amounts[2] = 1000e6;    // 1000 tokens
        amounts[3] = 1;         // 1 wei (smallest unit)

        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 amt = amounts[i];

            Quote[] memory quotes = localRouter.quoteTransferRemote(
                DESTINATION,
                BOB.addressToBytes32(),
                amt
            );

            uint256 hookFee = quotes[0].amount;
            uint256 amountPlusFee = quotes[1].amount;
            uint256 externalFee = quotes[2].amount;
            uint256 totalQuoted = hookFee + amountPlusFee + externalFee;

            // All fees should be reasonable in 6-decimal scale
            // If any fee were in 18-decimal scale, it would be >= 1e12 for non-dust amounts
            assertLt(
                hookFee,
                100e6,
                string.concat("hookFee too large for amount index ", vm.toString(i))
            );
            assertLt(
                amountPlusFee - amt,
                amt + 1, // fee should not exceed amount (LinearFee capped at maxFee=1e6)
                string.concat("feeRecipientFee too large for amount index ", vm.toString(i))
            );

            // Verify transfer succeeds with exact quoted amount
            vm.startPrank(ALICE);
            localErc20.approve(address(localRouter), totalQuoted);

            uint256 balBefore = localErc20.balanceOf(ALICE);
            localRouter.transferRemote{value: 0}(
                DESTINATION,
                BOB.addressToBytes32(),
                amt
            );
            vm.stopPrank();

            assertEq(
                balBefore - localErc20.balanceOf(ALICE),
                totalQuoted,
                string.concat("charge != quote for amount index ", vm.toString(i))
            );
        }
    }

    /// @notice Verify that the outbound message amount is in 18-decimal scale
    ///         while all charges to the sender are in 6-decimal scale
    function test_outboundAmountScaled_chargesLocal() public {
        Quote[] memory quotes = localRouter.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        uint256 totalQuoted = quotes[0].amount + quotes[1].amount + quotes[2].amount;

        vm.startPrank(ALICE);
        localErc20.approve(address(localRouter), totalQuoted);

        // Expect the SentTransferRemote event with SCALED amount (18-decimal)
        uint256 expectedOutbound = TRANSFER_AMT * SCALE_NUMERATOR / SCALE_DENOMINATOR;
        // 100e6 * 1e18 / 1e6 = 100e18
        assertEq(expectedOutbound, 100e18, "expected outbound sanity check");

        vm.expectEmit(true, true, false, true);
        emit SentTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            expectedOutbound
        );

        localRouter.transferRemote{value: 0}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        vm.stopPrank();

        // The charge was in 6-decimal local scale (verified in other tests)
        // The message amount is in 18-decimal outbound scale
        // These are correctly decoupled
    }

    // ============ Events ============

    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    // ============ Helpers ============

    function _setTokenGasConfig(
        address _token,
        uint32 _domain,
        StorageGasOracle _oracle
    ) internal {
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory params = new InterchainGasPaymaster.TokenGasOracleConfig[](1);
        params[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            _token,
            _domain,
            IGasOracle(address(_oracle))
        );
        igp.setTokenGasOracles(params);
    }
}
