// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

import {TokenBridgeKatanaVaultHelper} from "../../contracts/token/TokenBridgeKatanaVaultHelper.sol";
import {TokenBridgeKatanaRedeemIca} from "../../contracts/token/TokenBridgeKatanaRedeemIca.sol";
import {TokenBridgeOft} from "../../contracts/token/TokenBridgeOft.sol";
import {IKatanaVaultRedeemer} from "../../contracts/token/interfaces/IKatanaVaultRedeemer.sol";
import {IInterchainAccountRouter} from "../../contracts/interfaces/IInterchainAccountRouter.sol";
import {IWETH} from "../../contracts/token/interfaces/IWETH.sol";
import {IOFT, SendParam, MessagingFee, MessagingReceipt, OFTReceipt, OFTLimit, OFTFeeDetail} from "../../contracts/token/interfaces/layerzero/IOFT.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {CallLib} from "../../contracts/middleware/libs/Call.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract MockWETH is MockERC20, IWETH {
    constructor() MockERC20("Wrapped Ether", "WETH", 18) {}

    function deposit() external payable override {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external override {
        _burn(msg.sender, amount);
        payable(msg.sender).transfer(amount);
    }

    receive() external payable {}
}

contract MockShareVault is ERC4626 {
    bool public revertRedeem;

    constructor(
        address _asset,
        string memory _name,
        string memory _symbol
    ) ERC4626(IERC20(_asset)) ERC20(_name, _symbol) {}

    function setRevertRedeem(bool _revert) external {
        revertRedeem = _revert;
    }

    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override returns (uint256 assets) {
        require(!revertRedeem, "MockShareVault: redeem reverted");
        return super.redeem(shares, receiver, owner);
    }
}

contract MockComposeOFT is IOFT {
    address public immutable tokenAddress;
    bool public approvalRequiredValue;
    uint256 public nativeFeeToReturn;
    uint256 public feeBps;
    bytes32 public guidToReturn;
    uint8 public immutable sharedDecimalsValue;

    SendParam internal _lastSendParam;
    address public lastRefundAddress;
    uint256 public lastNativeFee;

    constructor(address _token, bool _approvalRequired, uint8 _sharedDecimals) {
        tokenAddress = _token;
        approvalRequiredValue = _approvalRequired;
        nativeFeeToReturn = 0.001 ether;
        guidToReturn = keccak256("mock-guid");
        sharedDecimalsValue = _sharedDecimals;
    }

    function setNativeFee(uint256 _fee) external {
        nativeFeeToReturn = _fee;
    }

    function setFeeBps(uint256 _feeBps) external {
        feeBps = _feeBps;
    }

    function setGuid(bytes32 _guid) external {
        guidToReturn = _guid;
    }

    function oftVersion() external pure override returns (bytes4, uint64) {
        return (bytes4(0x02e49c2c), 1);
    }

    function token() external view override returns (address) {
        return tokenAddress;
    }

    function approvalRequired() external view override returns (bool) {
        return approvalRequiredValue;
    }

    function sharedDecimals() external view override returns (uint8) {
        return sharedDecimalsValue;
    }

    function quoteSend(
        SendParam calldata,
        bool
    ) external view override returns (MessagingFee memory) {
        return MessagingFee({nativeFee: nativeFeeToReturn, lzTokenFee: 0});
    }

    function quoteOFT(
        SendParam calldata _sendParam
    )
        external
        view
        override
        returns (OFTLimit memory, OFTFeeDetail[] memory, OFTReceipt memory)
    {
        uint256 sent = _sendParam.amountLD;
        uint256 received = sent - ((sent * feeBps) / 10000);
        return (
            OFTLimit({minAmountLD: 0, maxAmountLD: type(uint256).max}),
            new OFTFeeDetail[](0),
            OFTReceipt({amountSentLD: sent, amountReceivedLD: received})
        );
    }

    function send(
        SendParam calldata _sendParam,
        MessagingFee calldata _fee,
        address _refundAddress
    )
        external
        payable
        override
        returns (MessagingReceipt memory, OFTReceipt memory)
    {
        _lastSendParam = _sendParam;
        lastRefundAddress = _refundAddress;
        lastNativeFee = msg.value;

        IERC20(tokenAddress).transferFrom(
            msg.sender,
            address(this),
            _sendParam.amountLD
        );

        uint256 received = _sendParam.amountLD -
            ((_sendParam.amountLD * feeBps) / 10000);
        require(
            received >= _sendParam.minAmountLD,
            "MockComposeOFT: SlippageExceeded"
        );

        return (
            MessagingReceipt({guid: guidToReturn, nonce: 1, fee: _fee}),
            OFTReceipt({
                amountSentLD: _sendParam.amountLD,
                amountReceivedLD: received
            })
        );
    }

    function lastSendParam() external view returns (SendParam memory) {
        return _lastSendParam;
    }
}

contract MockInterchainAccountRouter is IInterchainAccountRouter {
    uint256 public gasFeeToReturn = 0.002 ether;
    bytes32 public messageIdToReturn = keccak256("mock-ica-guid");

    uint32 public lastDestination;
    address public lastCallTo;
    uint256 public lastCallValue;
    bytes public lastCallData;
    bytes public lastHookMetadata;
    uint256 public lastNativeFee;

    function setGasFee(uint256 _fee) external {
        gasFeeToReturn = _fee;
    }

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
        return messageIdToReturn;
    }
}

abstract contract TokenBridgeKatanaVaultHelperBaseTest is Test {
    uint32 internal constant KATANA_DOMAIN = 747474;
    uint32 internal constant KATANA_EID = 30375;

    address internal owner = makeAddr("owner");
    address internal caller = makeAddr("caller");
    address internal ethereumBeneficiary = makeAddr("beneficiary");
    bytes32 internal katanaBeneficiary =
        bytes32(uint256(uint160(makeAddr("katanaBeneficiary"))));

    TokenBridgeOft internal shareBridge;
    MockComposeOFT internal shareOft;
    TokenBridgeKatanaVaultHelper internal helper;

    function _deployBridge(
        address _shareVault,
        uint8 _sharedDecimals
    ) internal {
        shareOft = new MockComposeOFT(_shareVault, true, _sharedDecimals);
        shareBridge = new TokenBridgeOft(address(shareOft), owner);

        vm.prank(owner);
        shareBridge.addDomain(KATANA_DOMAIN, KATANA_EID);
    }
}

contract TokenBridgeKatanaVaultHelperUsdcTest is
    TokenBridgeKatanaVaultHelperBaseTest
{
    MockERC20 internal usdc;
    MockShareVault internal shareVault;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        shareVault = new MockShareVault(
            address(usdc),
            "Vault Bridge USDC",
            "vbUSDC"
        );
        _deployBridge(address(shareVault), 6);

        helper = new TokenBridgeKatanaVaultHelper(
            address(shareVault),
            address(shareBridge),
            katanaBeneficiary,
            ethereumBeneficiary,
            address(0)
        );

        usdc.mint(caller, 1_000e6);
        vm.deal(caller, 10 ether);
    }

    function test_quoteTransferRemote_usesVaultAndShareBridgeQuotes() public {
        shareOft.setFeeBps(100);

        Quote[] memory quotes = helper.quoteTransferRemote(
            KATANA_DOMAIN,
            katanaBeneficiary,
            100e6
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 0.001 ether);
        assertEq(quotes[1].token, address(usdc));
        assertEq(quotes[1].amount, 101010102);
    }

    function test_constructor_revertsForZeroKatanaBeneficiary() public {
        vm.expectRevert(
            TokenBridgeKatanaVaultHelper
                .TokenBridgeKatanaVaultHelper__ZeroKatanaBeneficiary
                .selector
        );
        new TokenBridgeKatanaVaultHelper(
            address(shareVault),
            address(shareBridge),
            bytes32(0),
            ethereumBeneficiary,
            address(0)
        );
    }

    function test_quoteTransferRemote_revertsForZeroShareQuote() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridgeKatanaVaultHelper
                    .TokenBridgeKatanaVaultHelper__ZeroShareQuote
                    .selector,
                0
            )
        );
        helper.quoteTransferRemote(KATANA_DOMAIN, katanaBeneficiary, 0);
    }

    function test_transferRemote_mintsSharesAndBridgesThem() public {
        shareOft.setFeeBps(100);

        vm.startPrank(caller);
        usdc.approve(address(helper), type(uint256).max);
        bytes32 messageId = helper.transferRemote{value: 0.001 ether}(
            KATANA_DOMAIN,
            katanaBeneficiary,
            100e6
        );
        vm.stopPrank();

        assertEq(messageId, keccak256("mock-guid"));

        SendParam memory sendParam = shareOft.lastSendParam();
        assertEq(sendParam.dstEid, KATANA_EID);
        assertEq(sendParam.to, katanaBeneficiary);
        assertEq(sendParam.amountLD, 101010102);
        assertEq(sendParam.minAmountLD, 100e6);
        assertEq(sendParam.composeMsg.length, 0);

        assertEq(usdc.balanceOf(address(shareVault)), 101010102);
        assertEq(shareVault.balanceOf(address(helper)), 0);
        assertEq(usdc.balanceOf(caller), 898989898);
    }

    function test_transferRemote_refundsExcessNative() public {
        uint256 callerBalanceBefore = caller.balance;

        vm.startPrank(caller);
        usdc.approve(address(helper), type(uint256).max);
        helper.transferRemote{value: 0.01 ether}(
            KATANA_DOMAIN,
            katanaBeneficiary,
            25e6
        );
        vm.stopPrank();

        assertEq(caller.balance, callerBalanceBefore - 0.001 ether);
    }

    function test_redeem_isPermissionless() public {
        usdc.mint(address(this), 55e6);
        usdc.approve(address(shareVault), 55e6);
        shareVault.deposit(55e6, address(helper));

        vm.prank(makeAddr("poker"));
        helper.redeem(55e6);

        assertEq(usdc.balanceOf(ethereumBeneficiary), 55e6);
        assertEq(shareVault.balanceOf(address(helper)), 0);
    }
}

contract TokenBridgeKatanaVaultHelperWbtcTest is
    TokenBridgeKatanaVaultHelperBaseTest
{
    MockERC20 internal wbtc;
    MockShareVault internal shareVault;

    function setUp() public {
        wbtc = new MockERC20("Wrapped BTC", "WBTC", 8);
        shareVault = new MockShareVault(
            address(wbtc),
            "Vault Bridge WBTC",
            "vbWBTC"
        );
        _deployBridge(address(shareVault), 6);

        helper = new TokenBridgeKatanaVaultHelper(
            address(shareVault),
            address(shareBridge),
            katanaBeneficiary,
            ethereumBeneficiary,
            address(0)
        );

        wbtc.mint(caller, 10 * 1e8);
        vm.deal(caller, 10 ether);
    }

    function test_quoteTransferRemote_roundsDustyAmountsUp() public {
        Quote[] memory quotes = helper.quoteTransferRemote(
            KATANA_DOMAIN,
            katanaBeneficiary,
            123456789
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 0.001 ether);
        assertEq(quotes[1].token, address(wbtc));
        assertEq(quotes[1].amount, 123456800);
    }

    function test_transferRemote_bridgesRoundedShareAmount() public {
        vm.startPrank(caller);
        wbtc.approve(address(helper), type(uint256).max);
        helper.transferRemote{value: 0.001 ether}(
            KATANA_DOMAIN,
            katanaBeneficiary,
            123456789
        );
        vm.stopPrank();

        SendParam memory sendParam = shareOft.lastSendParam();
        assertEq(sendParam.amountLD, 123456800);
        assertEq(sendParam.minAmountLD, 123456700);
        assertEq(wbtc.balanceOf(caller), (10 * 1e8) - 123456800);
    }

    function test_redeem_transfersRoundedSharesToBeneficiary() public {
        wbtc.mint(address(this), 123456800);
        wbtc.approve(address(shareVault), 123456800);
        shareVault.deposit(123456800, address(helper));

        helper.redeem(123456800);

        assertEq(wbtc.balanceOf(ethereumBeneficiary), 123456800);
    }
}

contract TokenBridgeKatanaVaultHelperEthTest is
    TokenBridgeKatanaVaultHelperBaseTest
{
    MockWETH internal weth;
    MockShareVault internal shareVault;

    function setUp() public {
        weth = new MockWETH();
        shareVault = new MockShareVault(
            address(weth),
            "Vault Bridge ETH",
            "vbETH"
        );
        _deployBridge(address(shareVault), 6);

        helper = new TokenBridgeKatanaVaultHelper(
            address(shareVault),
            address(shareBridge),
            katanaBeneficiary,
            ethereumBeneficiary,
            address(weth)
        );

        vm.deal(caller, 10 ether);
    }

    function test_token_isNativeEth() public view {
        assertEq(helper.token(), address(0));
    }

    function test_quoteTransferRemote_mergesAssetAndFeeIntoNativeQuote()
        public
    {
        uint256 amount = 1 ether + 1;
        Quote[] memory quotes = helper.quoteTransferRemote(
            KATANA_DOMAIN,
            katanaBeneficiary,
            amount
        );

        assertEq(quotes.length, 1);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 1_000_001_000_000_000_000 + 0.001 ether);
    }

    function test_transferRemote_wrapsNativeEthAndRefundsExcess() public {
        uint256 amount = 1 ether + 1;
        uint256 totalRequired = 1_000_001_000_000_000_000 + 0.001 ether;
        uint256 callerBalanceBefore = caller.balance;

        vm.prank(caller);
        helper.transferRemote{value: totalRequired + 0.5 ether}(
            KATANA_DOMAIN,
            katanaBeneficiary,
            amount
        );

        SendParam memory sendParam = shareOft.lastSendParam();
        assertEq(sendParam.amountLD, 1_000_001_000_000_000_000);
        assertEq(sendParam.minAmountLD, 1 ether);
        assertEq(shareVault.balanceOf(address(helper)), 0);
        assertEq(caller.balance, callerBalanceBefore - totalRequired);
    }

    function test_redeem_unwrapsAndPaysNativeEth() public {
        vm.deal(address(this), 2 ether);
        weth.deposit{value: 2 ether}();
        weth.approve(address(shareVault), 2 ether);
        shareVault.deposit(2 ether, address(helper));

        uint256 beneficiaryBalanceBefore = ethereumBeneficiary.balance;
        helper.redeem(2 ether);

        assertEq(
            ethereumBeneficiary.balance,
            beneficiaryBalanceBefore + 2 ether
        );
        assertEq(address(helper).balance, 0);
        assertEq(weth.balanceOf(address(helper)), 0);
    }
}

abstract contract TokenBridgeKatanaRedeemIcaBaseTest is Test {
    using TypeCasts for address;

    uint32 internal constant ETH_DOMAIN = 1;
    uint32 internal constant ETH_EID = 30101;
    uint256 internal constant REDEEM_GAS_LIMIT = 500_000;

    address internal owner = makeAddr("owner");
    address internal caller = makeAddr("caller");
    address internal ethereumVaultHelper = makeAddr("ethereumHelper");
    address internal ethereumBeneficiary = makeAddr("beneficiary");

    MockComposeOFT internal shareOft;
    MockInterchainAccountRouter internal icaRouter;
    TokenBridgeOft internal shareBridge;
    TokenBridgeKatanaRedeemIca internal bridge;

    function _deployRedeemBridge(
        address _shareVault,
        uint8 _sharedDecimals
    ) internal {
        shareOft = new MockComposeOFT(_shareVault, false, _sharedDecimals);
        icaRouter = new MockInterchainAccountRouter();

        shareBridge = new TokenBridgeOft(address(shareOft), owner);
        vm.prank(owner);
        shareBridge.addDomain(ETH_DOMAIN, ETH_EID);

        bridge = new TokenBridgeKatanaRedeemIca(
            address(shareBridge),
            address(icaRouter),
            ethereumVaultHelper,
            ethereumBeneficiary,
            REDEEM_GAS_LIMIT
        );
    }
}

contract TokenBridgeKatanaRedeemIcaUsdcTest is
    TokenBridgeKatanaRedeemIcaBaseTest
{
    MockERC20 internal usdc;
    MockShareVault internal shareVault;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        shareVault = new MockShareVault(
            address(usdc),
            "Vault Bridge USDC",
            "vbUSDC"
        );
        _deployRedeemBridge(address(shareVault), 6);

        usdc.mint(caller, 1_000e6);
        vm.startPrank(caller);
        usdc.approve(address(shareVault), type(uint256).max);
        shareVault.deposit(1_000e6, caller);
        shareVault.approve(address(bridge), type(uint256).max);
        vm.stopPrank();
        vm.deal(caller, 10 ether);
    }

    function test_quoteTransferRemote() public {
        shareOft.setFeeBps(100);
        Quote[] memory quotes = bridge.quoteTransferRemote(
            ETH_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            100e6
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 0.003 ether);
        assertEq(quotes[1].token, address(shareVault));
        assertEq(quotes[1].amount, 101010102);
    }

    function test_transferRemote_dispatchesDeliveredShareAmount() public {
        vm.prank(caller);
        bridge.transferRemote{value: 0.003 ether}(
            ETH_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            50e6
        );

        SendParam memory sendParam = shareOft.lastSendParam();
        assertEq(sendParam.amountLD, 50e6);
        assertEq(sendParam.minAmountLD, 50e6);
        assertEq(
            icaRouter.lastCallData(),
            abi.encodeCall(IKatanaVaultRedeemer.redeem, (50e6))
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

contract TokenBridgeKatanaRedeemIcaWbtcTest is
    TokenBridgeKatanaRedeemIcaBaseTest
{
    MockERC20 internal wbtc;
    MockShareVault internal shareVault;

    function setUp() public {
        wbtc = new MockERC20("Wrapped BTC", "WBTC", 8);
        shareVault = new MockShareVault(
            address(wbtc),
            "Vault Bridge WBTC",
            "vbWBTC"
        );
        _deployRedeemBridge(address(shareVault), 6);

        wbtc.mint(caller, 10 * 1e8);
        vm.startPrank(caller);
        wbtc.approve(address(shareVault), type(uint256).max);
        shareVault.deposit(10 * 1e8, caller);
        shareVault.approve(address(bridge), type(uint256).max);
        vm.stopPrank();
        vm.deal(caller, 10 ether);
    }

    function test_quoteTransferRemote_supportsDustyWbtcShares() public {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            ETH_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            123456789
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[1].token, address(shareVault));
        assertEq(quotes[1].amount, 123456800);
    }

    function test_transferRemote_redeemsExactDeliveredWbtcShares() public {
        shareOft.setFeeBps(100);

        vm.prank(caller);
        bridge.transferRemote{value: 0.003 ether}(
            ETH_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            123456789
        );

        SendParam memory sendParam = shareOft.lastSendParam();
        uint256 deliveredShares = sendParam.amountLD -
            ((sendParam.amountLD * 100) / 10000);

        assertEq(sendParam.minAmountLD, 123456700);
        assertEq(
            icaRouter.lastCallData(),
            abi.encodeCall(IKatanaVaultRedeemer.redeem, (deliveredShares))
        );
    }
}

contract TokenBridgeKatanaRedeemIcaEthTest is
    TokenBridgeKatanaRedeemIcaBaseTest
{
    MockWETH internal weth;
    MockShareVault internal shareVault;

    function setUp() public {
        weth = new MockWETH();
        shareVault = new MockShareVault(
            address(weth),
            "Vault Bridge ETH",
            "vbETH"
        );
        _deployRedeemBridge(address(shareVault), 6);

        vm.deal(caller, 10 ether);
        vm.startPrank(caller);
        weth.deposit{value: 3 ether}();
        weth.approve(address(shareVault), type(uint256).max);
        shareVault.deposit(3 ether, caller);
        shareVault.approve(address(bridge), type(uint256).max);
        vm.stopPrank();
    }

    function test_quoteTransferRemote_supportsDustyEthShares() public {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            ETH_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            1 ether + 1
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[1].token, address(shareVault));
        assertEq(quotes[1].amount, 1_000_001_000_000_000_000);
    }

    function test_transferRemote_redeemsRoundedEthShareAmount() public {
        vm.prank(caller);
        bridge.transferRemote{value: 0.003 ether}(
            ETH_DOMAIN,
            TypeCasts.addressToBytes32(ethereumBeneficiary),
            1 ether + 1
        );

        SendParam memory sendParam = shareOft.lastSendParam();
        assertEq(sendParam.amountLD, 1_000_001_000_000_000_000);
        assertEq(sendParam.minAmountLD, 1 ether);
        assertEq(
            icaRouter.lastCallData(),
            abi.encodeCall(IKatanaVaultRedeemer.redeem, (sendParam.amountLD))
        );
    }
}
