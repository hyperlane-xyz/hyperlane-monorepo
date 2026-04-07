// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {TokenBridgeKatanaVaultHelper} from "../../contracts/token/TokenBridgeKatanaVaultHelper.sol";
import {TokenBridgeKatanaRedeemIca} from "../../contracts/token/TokenBridgeKatanaRedeemIca.sol";
import {TokenBridgeOft} from "../../contracts/token/TokenBridgeOft.sol";
import {IKatanaVaultRedeemer} from "../../contracts/token/interfaces/IKatanaVaultRedeemer.sol";
import {IInterchainAccountRouter} from "../../contracts/interfaces/IInterchainAccountRouter.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {Quotes} from "../../contracts/token/libs/Quotes.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {CallLib} from "../../contracts/middleware/libs/Call.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {IOFT, SendParam, OFTReceipt, OFTLimit, OFTFeeDetail} from "../../contracts/token/interfaces/layerzero/IOFT.sol";

interface ISecondaryChainBalance {
    function secondaryChainBalance() external view returns (uint256);
}

contract MockForkInterchainAccountRouter is IInterchainAccountRouter {
    uint256 public gasFeeToReturn = 0.002 ether;

    uint32 public lastDestination;
    address public lastCallTo;
    uint256 public lastCallValue;
    bytes public lastCallData;
    bytes public lastHookMetadata;
    uint256 public lastNativeFee;

    function quoteGasPayment(
        uint32,
        uint256
    ) external view override returns (uint256) {
        return gasFeeToReturn;
    }

    function callRemote(
        uint32 _destination,
        CallLib.Call[] calldata _calls,
        bytes memory _hookMetadata
    ) external payable override returns (bytes32) {
        lastDestination = _destination;
        lastCallTo = TypeCasts.bytes32ToAddress(_calls[0].to);
        lastCallValue = _calls[0].value;
        lastCallData = _calls[0].data;
        lastHookMetadata = _hookMetadata;
        lastNativeFee = msg.value;
        return keccak256("mock-fork-ica-guid");
    }
}

abstract contract TokenBridgeKatanaVaultHelperForkBase is Test {
    uint32 internal constant KATANA_DOMAIN = 747474;
    uint32 internal constant KATANA_EID = 30375;

    string internal mainnetRpcUrl;
    address internal caller = makeAddr("caller");
    address internal ethereumBeneficiary = makeAddr("beneficiary");
    bytes32 internal katanaBeneficiary =
        TypeCasts.addressToBytes32(makeAddr("katanaBeneficiary"));

    TokenBridgeOft internal shareBridge;
    TokenBridgeKatanaVaultHelper internal helper;

    function _setUpMainnet(
        address _shareVault,
        address _oft,
        address _wrappedNativeToken
    ) internal {
        mainnetRpcUrl = vm.envOr(
            "RPC_URL_MAINNET",
            string("https://ethereum-rpc.publicnode.com")
        );
        vm.createSelectFork(mainnetRpcUrl);

        shareBridge = new TokenBridgeOft(_oft, address(this));
        shareBridge.addDomain(KATANA_DOMAIN, KATANA_EID);
        helper = new TokenBridgeKatanaVaultHelper(
            _shareVault,
            address(shareBridge),
            katanaBeneficiary,
            ethereumBeneficiary,
            _wrappedNativeToken
        );
    }
}

contract TokenBridgeKatanaVaultHelperUsdcForkTest is
    TokenBridgeKatanaVaultHelperForkBase
{
    address internal constant VBUSDC =
        0x53E82ABbb12638F09d9e624578ccB666217a765e;
    address internal constant VBUSDC_OFT =
        0xb5bADA33542a05395d504a25885e02503A957Bb3;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    function setUp() public {
        _setUpMainnet(VBUSDC, VBUSDC_OFT, address(0));
    }

    function testFork_quoteTransferRemote_matchesLiveShareBridge() public view {
        uint256 amount = 10e6;

        Quote[] memory helperQuotes = helper.quoteTransferRemote(
            KATANA_DOMAIN,
            katanaBeneficiary,
            amount
        );
        Quote[] memory shareQuotes = shareBridge.quoteTransferRemote(
            KATANA_DOMAIN,
            katanaBeneficiary,
            amount
        );

        uint256 requiredShares = Quotes.extract(shareQuotes, VBUSDC);
        assertEq(helperQuotes.length, 2);
        assertEq(helperQuotes[0].token, address(0));
        assertEq(
            helperQuotes[0].amount,
            Quotes.extract(shareQuotes, address(0))
        );
        assertEq(helperQuotes[1].token, USDC);
        assertEq(
            helperQuotes[1].amount,
            IERC4626(VBUSDC).previewMint(requiredShares)
        );
    }

    function testFork_transferRemote_bridgesLiveUsdcVaultShares() public {
        uint256 amount = 10e6;
        Quote[] memory helperQuotes = helper.quoteTransferRemote(
            KATANA_DOMAIN,
            katanaBeneficiary,
            amount
        );
        uint256 nativeFee = Quotes.extract(helperQuotes, address(0));
        uint256 assetsIn = Quotes.extract(helperQuotes, USDC);

        deal(USDC, caller, assetsIn);
        vm.deal(caller, nativeFee);

        vm.startPrank(caller);
        IERC20(USDC).approve(address(helper), assetsIn);
        bytes32 messageId = helper.transferRemote{value: nativeFee}(
            KATANA_DOMAIN,
            katanaBeneficiary,
            amount
        );
        vm.stopPrank();

        assertNotEq(messageId, bytes32(0));
        assertEq(IERC20(USDC).balanceOf(caller), 0);
        assertEq(IERC20(VBUSDC).balanceOf(address(helper)), 0);
    }
}

contract TokenBridgeKatanaVaultHelperEthForkTest is
    TokenBridgeKatanaVaultHelperForkBase
{
    address internal constant VBETH =
        0x2DC70fb75b88d2eB4715bc06E1595E6D97c34DFF;
    address internal constant VBETH_OFT =
        0x8F45F7ACD4b9FC0B446902790F304d444dfF949b;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    function setUp() public {
        _setUpMainnet(VBETH, VBETH_OFT, WETH);
    }

    function testFork_quoteTransferRemote_mergesLiveNativeAssetAndFee()
        public
        view
    {
        uint256 amount = 1 ether + 1;

        Quote[] memory helperQuotes = helper.quoteTransferRemote(
            KATANA_DOMAIN,
            katanaBeneficiary,
            amount
        );
        Quote[] memory shareQuotes = shareBridge.quoteTransferRemote(
            KATANA_DOMAIN,
            katanaBeneficiary,
            amount
        );

        uint256 requiredShares = Quotes.extract(shareQuotes, VBETH);
        uint256 requiredAssets = IERC4626(VBETH).previewMint(requiredShares);

        assertEq(helperQuotes.length, 1);
        assertEq(helperQuotes[0].token, address(0));
        assertEq(
            helperQuotes[0].amount,
            Quotes.extract(shareQuotes, address(0)) + requiredAssets
        );
    }

    function testFork_transferRemote_wrapsAndBridgesLiveEthVaultShares()
        public
    {
        uint256 amount = 1 ether + 1;
        uint256 excess = 0.05 ether;
        Quote[] memory helperQuotes = helper.quoteTransferRemote(
            KATANA_DOMAIN,
            katanaBeneficiary,
            amount
        );
        uint256 totalNative = helperQuotes[0].amount;

        vm.deal(caller, totalNative + excess);

        vm.prank(caller);
        bytes32 messageId = helper.transferRemote{value: totalNative + excess}(
            KATANA_DOMAIN,
            katanaBeneficiary,
            amount
        );

        assertNotEq(messageId, bytes32(0));
        assertEq(caller.balance, excess);
        assertEq(IERC20(VBETH).balanceOf(address(helper)), 0);
        assertEq(IERC20(WETH).balanceOf(address(helper)), 0);
    }
}

abstract contract TokenBridgeKatanaRedeemIcaForkBase is Test {
    uint32 internal constant ETHEREUM_DOMAIN = 1;
    uint32 internal constant ETHEREUM_EID = 30101;
    uint256 internal constant REDEEM_GAS_LIMIT = 500_000;

    string internal katanaRpcUrl;
    address internal caller = makeAddr("caller");
    address internal ethereumVaultHelper = makeAddr("ethereumVaultHelper");
    address internal ethereumBeneficiary = makeAddr("ethereumBeneficiary");

    TokenBridgeOft internal shareBridge;
    TokenBridgeKatanaRedeemIca internal bridge;
    MockForkInterchainAccountRouter internal icaRouter;

    function _setUpKatana(address _oft) internal {
        katanaRpcUrl = vm.envOr(
            "RPC_URL_KATANA",
            string("https://rpc.katanarpc.com")
        );
        vm.createSelectFork(katanaRpcUrl);

        shareBridge = new TokenBridgeOft(_oft, address(this));
        shareBridge.addDomain(ETHEREUM_DOMAIN, ETHEREUM_EID);
        icaRouter = new MockForkInterchainAccountRouter();
        bridge = new TokenBridgeKatanaRedeemIca(
            address(shareBridge),
            address(icaRouter),
            ethereumVaultHelper,
            ethereumBeneficiary,
            REDEEM_GAS_LIMIT
        );
    }

    function _expectedDeliveredShares(
        uint256 _amount
    ) internal view returns (uint256) {
        Quote[] memory shareQuotes = shareBridge.quoteTransferRemote(
            ETHEREUM_DOMAIN,
            TypeCasts.addressToBytes32(ethereumVaultHelper),
            _amount
        );
        uint256 shareAmount = Quotes.extract(shareQuotes, shareBridge.token());

        SendParam memory sendParam = SendParam({
            dstEid: ETHEREUM_EID,
            to: TypeCasts.addressToBytes32(ethereumVaultHelper),
            amountLD: shareAmount,
            minAmountLD: _removeDust(_amount),
            extraOptions: shareBridge.extraOptions(),
            composeMsg: "",
            oftCmd: ""
        });

        (, OFTFeeDetail[] memory feeDetails, OFTReceipt memory receipt) = IOFT(
            address(shareBridge.oft())
        ).quoteOFT(sendParam);
        feeDetails;
        return receipt.amountReceivedLD;
    }

    function _requestedReceivedShares(
        uint256 _amount
    ) internal view returns (uint256) {
        SendParam memory sendParam = SendParam({
            dstEid: ETHEREUM_EID,
            to: TypeCasts.addressToBytes32(ethereumVaultHelper),
            amountLD: _amount,
            minAmountLD: 0,
            extraOptions: shareBridge.extraOptions(),
            composeMsg: "",
            oftCmd: ""
        });

        (, OFTFeeDetail[] memory feeDetails, OFTReceipt memory receipt) = IOFT(
            address(shareBridge.oft())
        ).quoteOFT(sendParam);
        feeDetails;
        return receipt.amountReceivedLD;
    }

    function _removeDust(uint256 _amount) internal view returns (uint256) {
        uint256 rate = shareBridge.decimalConversionRate();
        return (_amount / rate) * rate;
    }

    function _availableBridgeableShares() internal view returns (uint256) {
        return
            ISecondaryChainBalance(address(shareBridge.oft()))
                .secondaryChainBalance();
    }

    function _liveTransferableAmount() internal view returns (uint256 amount) {
        uint256 availableShares = _availableBridgeableShares();
        uint256 rate = shareBridge.decimalConversionRate();
        require(availableShares > rate, "insufficient live liquidity");

        amount = (availableShares / 10) + 1;
        if (amount <= rate) amount = rate + 1;

        for (uint256 i = 0; i < 16; ++i) {
            Quote[] memory bridgeQuotes = bridge.quoteTransferRemote(
                ETHEREUM_DOMAIN,
                TypeCasts.addressToBytes32(ethereumBeneficiary),
                amount
            );
            uint256 shareAmount = Quotes.extract(
                bridgeQuotes,
                shareBridge.token()
            );
            if (shareAmount != 0 && shareAmount <= availableShares)
                return amount;

            amount /= 2;
            if (amount <= rate) amount = rate + 1;
        }

        revert("no transferable amount");
    }
}

contract TokenBridgeKatanaRedeemIcaUsdcForkTest is
    TokenBridgeKatanaRedeemIcaForkBase
{
    address internal constant KATANA_VBUSDC_OFT =
        0x807275727Dd3E640c5F2b5DE7d1eC72B4Dd293C0;

    function setUp() public {
        _setUpKatana(KATANA_VBUSDC_OFT);
    }

    function testFork_quoteTransferRemote_matchesLiveUsdcShareBridge()
        public
        view
    {
        uint256 amount = 10e6;
        Quote[] memory bridgeQuotes = bridge.quoteTransferRemote(
            ETHEREUM_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            amount
        );
        Quote[] memory shareQuotes = shareBridge.quoteTransferRemote(
            ETHEREUM_DOMAIN,
            TypeCasts.addressToBytes32(ethereumVaultHelper),
            amount
        );

        assertEq(bridgeQuotes.length, 2);
        assertEq(bridgeQuotes[0].token, address(0));
        assertEq(
            bridgeQuotes[0].amount,
            Quotes.extract(shareQuotes, address(0)) + icaRouter.gasFeeToReturn()
        );
        assertEq(bridgeQuotes[1].token, shareBridge.token());
        assertEq(
            bridgeQuotes[1].amount,
            Quotes.extract(shareQuotes, shareBridge.token())
        );
    }

    function testFork_transferRemote_dispatchesLiveUsdcDeliveredShares()
        public
    {
        uint256 amount = 10e6;
        Quote[] memory bridgeQuotes = bridge.quoteTransferRemote(
            ETHEREUM_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            amount
        );
        uint256 nativeFee = Quotes.extract(bridgeQuotes, address(0));
        uint256 shareAmount = Quotes.extract(bridgeQuotes, shareBridge.token());
        uint256 deliveredShares = _expectedDeliveredShares(amount);

        deal(shareBridge.token(), caller, shareAmount);
        vm.deal(caller, nativeFee);

        vm.startPrank(caller);
        IERC20(shareBridge.token()).approve(address(bridge), shareAmount);
        bridge.transferRemote{value: nativeFee}(
            ETHEREUM_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            amount
        );
        vm.stopPrank();

        assertEq(icaRouter.lastCallTo(), ethereumVaultHelper);
        assertEq(
            icaRouter.lastCallData(),
            abi.encodeCall(IKatanaVaultRedeemer.redeem, (deliveredShares))
        );
        assertEq(
            StandardHookMetadata.gasLimit(icaRouter.lastHookMetadata()),
            REDEEM_GAS_LIMIT
        );
        assertEq(
            StandardHookMetadata.getRefundAddress(
                icaRouter.lastHookMetadata(),
                address(0)
            ),
            caller
        );
    }
}

contract TokenBridgeKatanaRedeemIcaEthForkTest is
    TokenBridgeKatanaRedeemIcaForkBase
{
    address internal constant KATANA_VBETH_OFT =
        0x694d1697F6909361775139357d99fb60b5caB683;

    function setUp() public {
        _setUpKatana(KATANA_VBETH_OFT);
    }

    function testFork_quoteTransferRemote_usesLiveEthDeliveredShares()
        public
        view
    {
        uint256 amount = 1 ether + 1;
        Quote[] memory bridgeQuotes = bridge.quoteTransferRemote(
            ETHEREUM_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            amount
        );
        uint256 shareAmount = Quotes.extract(bridgeQuotes, shareBridge.token());
        uint256 deliveredShares = _expectedDeliveredShares(amount);
        uint256 requestedReceivedShares = _requestedReceivedShares(amount);

        assertEq(_removeDust(amount), 1 ether);
        assertEq(requestedReceivedShares, 1 ether);
        assertEq(deliveredShares, shareAmount);
        assertGt(deliveredShares, requestedReceivedShares);
    }

    function testFork_transferRemote_dispatchesLiveEthDeliveredShares() public {
        uint256 amount = _liveTransferableAmount();
        Quote[] memory bridgeQuotes = bridge.quoteTransferRemote(
            ETHEREUM_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            amount
        );
        uint256 nativeFee = Quotes.extract(bridgeQuotes, address(0));
        uint256 shareAmount = Quotes.extract(bridgeQuotes, shareBridge.token());
        uint256 deliveredShares = _expectedDeliveredShares(amount);

        assertLe(shareAmount, _availableBridgeableShares());

        deal(shareBridge.token(), caller, shareAmount);
        vm.deal(caller, nativeFee);

        vm.startPrank(caller);
        IERC20(shareBridge.token()).approve(address(bridge), shareAmount);
        bridge.transferRemote{value: nativeFee}(
            ETHEREUM_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            amount
        );
        vm.stopPrank();

        assertEq(icaRouter.lastCallTo(), ethereumVaultHelper);
        assertEq(
            icaRouter.lastCallData(),
            abi.encodeCall(IKatanaVaultRedeemer.redeem, (deliveredShares))
        );
        assertEq(
            StandardHookMetadata.gasLimit(icaRouter.lastHookMetadata()),
            REDEEM_GAS_LIMIT
        );
        assertEq(
            StandardHookMetadata.getRefundAddress(
                icaRouter.lastHookMetadata(),
                address(0)
            ),
            caller
        );
    }
}

contract TokenBridgeKatanaRedeemIcaWbtcForkTest is
    TokenBridgeKatanaRedeemIcaForkBase
{
    address internal constant KATANA_VBWBTC_OFT =
        0x8169e532Bc781985e155037db1F96c267a520DFC;

    function setUp() public {
        _setUpKatana(KATANA_VBWBTC_OFT);
    }

    function testFork_quoteTransferRemote_usesLiveWbtcDeliveredShares()
        public
        view
    {
        uint256 amount = 123456789;
        Quote[] memory bridgeQuotes = bridge.quoteTransferRemote(
            ETHEREUM_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            amount
        );
        uint256 shareAmount = Quotes.extract(bridgeQuotes, shareBridge.token());
        uint256 deliveredShares = _expectedDeliveredShares(amount);
        uint256 requestedReceivedShares = _requestedReceivedShares(amount);

        assertEq(_removeDust(amount), 123456700);
        assertEq(requestedReceivedShares, 123456700);
        assertEq(deliveredShares, shareAmount);
        assertGt(deliveredShares, requestedReceivedShares);
    }

    function testFork_transferRemote_dispatchesLiveWbtcDeliveredShares()
        public
    {
        uint256 amount = _liveTransferableAmount();
        Quote[] memory bridgeQuotes = bridge.quoteTransferRemote(
            ETHEREUM_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            amount
        );
        uint256 nativeFee = Quotes.extract(bridgeQuotes, address(0));
        uint256 shareAmount = Quotes.extract(bridgeQuotes, shareBridge.token());
        uint256 deliveredShares = _expectedDeliveredShares(amount);

        assertLe(shareAmount, _availableBridgeableShares());

        deal(shareBridge.token(), caller, shareAmount);
        vm.deal(caller, nativeFee);

        vm.startPrank(caller);
        IERC20(shareBridge.token()).approve(address(bridge), shareAmount);
        bridge.transferRemote{value: nativeFee}(
            ETHEREUM_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            amount
        );
        vm.stopPrank();

        assertEq(icaRouter.lastCallTo(), ethereumVaultHelper);
        assertEq(
            icaRouter.lastCallData(),
            abi.encodeCall(IKatanaVaultRedeemer.redeem, (deliveredShares))
        );
        assertEq(
            StandardHookMetadata.gasLimit(icaRouter.lastHookMetadata()),
            REDEEM_GAS_LIMIT
        );
        assertEq(
            StandardHookMetadata.getRefundAddress(
                icaRouter.lastHookMetadata(),
                address(0)
            ),
            caller
        );
    }
}
