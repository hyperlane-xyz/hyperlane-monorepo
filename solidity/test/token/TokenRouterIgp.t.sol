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
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * @title TokenRouterIgpTest
 * @notice Tests for ERC20 IGP payment functionality in TokenRouter
 */
contract TokenRouterIgpTest is Test {
    using TypeCasts for address;
    using StandardHookMetadata for bytes;

    uint32 internal constant ORIGIN = 1;
    uint32 internal constant DESTINATION = 2;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal constant TRANSFER_AMT = 100e18;
    uint256 internal constant GAS_LIMIT = 50_000;
    uint128 internal constant GAS_PRICE = 10;
    uint96 internal constant GAS_OVERHEAD = 10_000;
    uint128 internal constant TOKEN_EXCHANGE_RATE = 1e10; // 1:1 exchange

    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    address internal constant PROXY_ADMIN = address(0x37);

    // Tokens
    ERC20Test internal collateralToken;
    ERC20Test internal feeToken;

    // Infrastructure
    MockMailbox internal originMailbox;
    MockMailbox internal destMailbox;
    TestPostDispatchHook internal noopHook;
    InterchainGasPaymaster internal igp;
    StorageGasOracle internal gasOracle;

    // Routers
    HypERC20Collateral internal collateralRouter;
    HypERC20 internal syntheticRouter;
    HypERC20 internal remoteRouter;

    // Events
    event FeeHookSet(address feeHook);
    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    function setUp() public {
        // Deploy mailboxes
        originMailbox = new MockMailbox(ORIGIN);
        destMailbox = new MockMailbox(DESTINATION);
        originMailbox.addRemoteMailbox(DESTINATION, destMailbox);
        destMailbox.addRemoteMailbox(ORIGIN, originMailbox);

        // Deploy tokens
        collateralToken = new ERC20Test(
            "Collateral",
            "COL",
            TOTAL_SUPPLY,
            DECIMALS
        );
        feeToken = new ERC20Test("FeeToken", "FEE", TOTAL_SUPPLY, DECIMALS);

        // Deploy hooks
        noopHook = new TestPostDispatchHook();
        originMailbox.setDefaultHook(address(noopHook));
        originMailbox.setRequiredHook(address(noopHook));
        destMailbox.setDefaultHook(address(noopHook));
        destMailbox.setRequiredHook(address(noopHook));

        // Deploy IGP with token support
        igp = new InterchainGasPaymaster();
        igp.initialize(address(this), address(this));

        // Deploy gas oracle for token payments
        gasOracle = new StorageGasOracle();
        _setRemoteGasData(DESTINATION, TOKEN_EXCHANGE_RATE, GAS_PRICE);

        // Configure native token oracle first (required before ERC20 token oracles)
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

        // Now configure ERC20 fee token (requires domain to already be configured)
        _setTokenGasConfig(address(feeToken), DESTINATION, gasOracle);

        // Deploy collateral router
        collateralRouter = new HypERC20Collateral(
            address(collateralToken),
            SCALE,
            SCALE,
            address(originMailbox)
        );
        collateralRouter.initialize(
            address(noopHook),
            address(0),
            address(this)
        );

        // Deploy synthetic router (origin)
        HypERC20 syntheticImpl = new HypERC20(
            DECIMALS,
            SCALE,
            SCALE,
            address(originMailbox)
        );
        TransparentUpgradeableProxy syntheticProxy = new TransparentUpgradeableProxy(
                address(syntheticImpl),
                PROXY_ADMIN,
                abi.encodeWithSelector(
                    HypERC20.initialize.selector,
                    TOTAL_SUPPLY,
                    "Synthetic",
                    "SYN",
                    address(noopHook),
                    address(0),
                    address(this)
                )
            );
        syntheticRouter = HypERC20(address(syntheticProxy));

        // Deploy remote router (destination)
        HypERC20 remoteImpl = new HypERC20(
            DECIMALS,
            SCALE,
            SCALE,
            address(destMailbox)
        );
        TransparentUpgradeableProxy remoteProxy = new TransparentUpgradeableProxy(
                address(remoteImpl),
                PROXY_ADMIN,
                abi.encodeWithSelector(
                    HypERC20.initialize.selector,
                    0,
                    "Remote",
                    "RMT",
                    address(noopHook),
                    address(0),
                    address(this)
                )
            );
        remoteRouter = HypERC20(address(remoteProxy));

        // Enroll routers
        collateralRouter.enrollRemoteRouter(
            DESTINATION,
            address(remoteRouter).addressToBytes32()
        );
        syntheticRouter.enrollRemoteRouter(
            DESTINATION,
            address(remoteRouter).addressToBytes32()
        );
        remoteRouter.enrollRemoteRouter(
            ORIGIN,
            address(collateralRouter).addressToBytes32()
        );

        // Set destination gas
        GasRouter.GasRouterConfig[]
            memory gasConfigs = new GasRouter.GasRouterConfig[](1);
        gasConfigs[0] = GasRouter.GasRouterConfig({
            domain: DESTINATION,
            gas: GAS_LIMIT
        });
        collateralRouter.setDestinationGas(gasConfigs);
        syntheticRouter.setDestinationGas(gasConfigs);

        // Fund ALICE
        collateralToken.transfer(ALICE, TOTAL_SUPPLY / 2);
        feeToken.transfer(ALICE, TOTAL_SUPPLY / 2);
        syntheticRouter.transfer(ALICE, TOTAL_SUPPLY / 2);
    }

    // ============ Setter Tests ============

    function test_setFeeHook() public {
        vm.expectEmit(true, true, true, true);
        emit FeeHookSet(address(igp));
        collateralRouter.setFeeHook(address(igp));

        assertEq(collateralRouter.feeHook(), address(igp));
    }

    function test_setFeeHook_revertsIfNotOwner() public {
        vm.prank(ALICE);
        vm.expectRevert("Ownable: caller is not the owner");
        collateralRouter.setFeeHook(address(igp));
    }

    // ============ Quote Tests ============

    function test_quoteTransferRemote_withERC20Igp() public {
        // Set up IGP gas config for collateralToken (which is token() for collateralRouter)
        _setTokenGasConfig(address(collateralToken), DESTINATION, gasOracle);

        // Configure ERC20 IGP (setting feeHook enables token fees)
        collateralRouter.setFeeHook(address(igp));
        collateralRouter.setHook(address(igp));

        Quote[] memory quotes = collateralRouter.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        // Quote[0] should be the IGP fee in collateralToken (the router's token())
        assertEq(
            quotes[0].token,
            address(collateralToken),
            "Quote[0].token should be collateralToken"
        );
        assertGt(quotes[0].amount, 0, "Quote[0].amount should be > 0");

        // Quote[1] should be the transfer amount in collateral token
        assertEq(
            quotes[1].token,
            address(collateralToken),
            "Quote[1].token should be collateral"
        );
        assertEq(
            quotes[1].amount,
            TRANSFER_AMT,
            "Quote[1].amount should be transfer amount"
        );
    }

    function test_quoteTransferRemote_nativeIgp_whenNotConfigured() public {
        // Default: feeToken = address(0), igp = address(0)
        Quote[] memory quotes = collateralRouter.quoteTransferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        // Quote[0] should be native (address(0))
        assertEq(
            quotes[0].token,
            address(0),
            "Quote[0].token should be native"
        );
    }

    // ============ HypERC20Collateral Tests (feeToken == collateral) ============

    function test_transferRemote_withERC20Igp_sameToken() public {
        // Use collateralToken as both collateral AND fee token (token() returns collateralToken)
        _setTokenGasConfig(address(collateralToken), DESTINATION, gasOracle);

        // Setting feeHook enables token fees
        collateralRouter.setFeeHook(address(igp));
        collateralRouter.setHook(address(igp));

        // Calculate expected IGP fee (token payments use same overhead as native)
        uint256 totalGas = igp.destinationGasLimit(DESTINATION, GAS_LIMIT);
        uint256 igpFee = igp.quoteGasPayment(
            address(collateralToken),
            DESTINATION,
            totalGas
        );

        uint256 totalCharge = TRANSFER_AMT + igpFee;

        // Approve router for total charge
        vm.startPrank(ALICE);
        collateralToken.approve(address(collateralRouter), totalCharge);

        uint256 aliceBalanceBefore = collateralToken.balanceOf(ALICE);

        // Transfer with msg.value = 0 (ERC20 IGP)
        collateralRouter.transferRemote{value: 0}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        vm.stopPrank();

        // Verify ALICE was charged transfer amount + IGP fee
        uint256 aliceBalanceAfter = collateralToken.balanceOf(ALICE);
        assertEq(
            aliceBalanceBefore - aliceBalanceAfter,
            totalCharge,
            "ALICE should be charged transfer + IGP fee"
        );

        // Verify IGP received the fee
        assertEq(
            collateralToken.balanceOf(address(igp)),
            igpFee,
            "IGP should receive fee tokens"
        );
    }

    // ============ HypERC20 (Synthetic) Tests ============

    function test_transferRemote_withERC20Igp_syntheticToken() public {
        // Setting feeHook enables token fees - for HypERC20, token() returns address(this)
        syntheticRouter.setFeeHook(address(igp));
        syntheticRouter.setHook(address(igp));

        // Set up IGP config for synthetic token
        _setTokenGasConfig(address(syntheticRouter), DESTINATION, gasOracle);

        // Calculate expected IGP fee (token payments use same overhead as native)
        uint256 totalGas = igp.destinationGasLimit(DESTINATION, GAS_LIMIT);
        uint256 igpFee = igp.quoteGasPayment(
            address(syntheticRouter),
            DESTINATION,
            totalGas
        );

        uint256 totalCharge = TRANSFER_AMT + igpFee;

        vm.startPrank(ALICE);
        uint256 aliceSyntheticBefore = syntheticRouter.balanceOf(ALICE);

        // For synthetic tokens, user must approve the router to pull fee tokens
        // (because _transferFromSender burns, so fee must be pulled separately)
        syntheticRouter.approve(address(syntheticRouter), igpFee);

        // This should work - burn transfer amount, pull IGP fee separately
        syntheticRouter.transferRemote{value: 0}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        vm.stopPrank();

        // Verify total charge was burned from ALICE
        assertEq(
            aliceSyntheticBefore - syntheticRouter.balanceOf(ALICE),
            totalCharge,
            "Total charge should be burned from ALICE"
        );

        // Verify IGP received the fee tokens
        assertEq(
            syntheticRouter.balanceOf(address(igp)),
            igpFee,
            "IGP should receive fee tokens"
        );
    }

    // ============ Edge Cases ============

    function test_transferRemote_nativeIgp_whenFeeHookNotSet() public {
        // Default: feeHook = address(0)
        // Should use native IGP (existing behavior)

        vm.startPrank(ALICE);
        collateralToken.approve(address(collateralRouter), TRANSFER_AMT);

        uint256 aliceBalanceBefore = collateralToken.balanceOf(ALICE);

        // Transfer with native value for IGP
        uint256 nativeValue = noopHook.quoteDispatch("", "");
        collateralRouter.transferRemote{value: nativeValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        vm.stopPrank();

        // Verify transfer succeeded
        assertEq(
            aliceBalanceBefore - collateralToken.balanceOf(ALICE),
            TRANSFER_AMT,
            "Transfer should succeed with native IGP"
        );
    }

    function test_transferRemote_withERC20Igp_insufficientAllowance() public {
        // Set up IGP gas config for collateralToken
        _setTokenGasConfig(address(collateralToken), DESTINATION, gasOracle);

        // Setting feeHook enables token fees
        collateralRouter.setFeeHook(address(igp));
        collateralRouter.setHook(address(igp));

        vm.startPrank(ALICE);
        // Only approve transfer amount, not transfer + IGP fee
        collateralToken.approve(address(collateralRouter), TRANSFER_AMT);

        vm.expectRevert("ERC20: insufficient allowance");
        collateralRouter.transferRemote{value: 0}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        vm.stopPrank();
    }

    function test_transferRemote_withERC20Igp_insufficientBalance() public {
        // Set up IGP gas config for collateralToken
        _setTokenGasConfig(address(collateralToken), DESTINATION, gasOracle);

        // Setting feeHook enables token fees
        collateralRouter.setFeeHook(address(igp));
        collateralRouter.setHook(address(igp));

        // Use a user with only enough for transfer but not transfer + IGP fee
        address poorUser = address(0x999);
        collateralToken.transfer(poorUser, TRANSFER_AMT);

        vm.startPrank(poorUser);
        // Approve max but only have TRANSFER_AMT balance (not enough for + IGP fee)
        collateralToken.approve(address(collateralRouter), type(uint256).max);

        vm.expectRevert("ERC20: transfer amount exceeds balance");
        collateralRouter.transferRemote{value: 0}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        vm.stopPrank();
    }

    // ============ Internal Helpers ============

    function _setTokenGasConfig(
        address _token,
        uint32 _domain,
        StorageGasOracle _oracle
    ) internal {
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory params = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        params[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            _token,
            _domain,
            IGasOracle(address(_oracle))
        );
        igp.setTokenGasOracles(params);
    }

    function _setRemoteGasData(
        uint32 _domain,
        uint128 _exchangeRate,
        uint128 _gasPrice
    ) internal {
        gasOracle.setRemoteGasData(
            StorageGasOracle.RemoteGasDataConfig({
                remoteDomain: _domain,
                tokenExchangeRate: _exchangeRate,
                gasPrice: _gasPrice
            })
        );
    }
}
