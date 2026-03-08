// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Test.sol";

import {TokenBridgeOft} from "../contracts/TokenBridgeOft.sol";
import {IOFT, SendParam, MessagingFee, OFTReceipt, OFTLimit, OFTFeeDetail} from "../contracts/interfaces/layerzero/IOFT.sol";
import {Quote} from "@hyperlane-xyz/core/interfaces/ITokenBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Hyperlane Mailbox on Arbitrum
address constant MAILBOX_ARBITRUM = 0x979Ca5202784112f4738403dBec5D0F3B9daabB9;
// Hyperlane Mailbox on Ethereum
address constant MAILBOX_ETHEREUM = 0xc005dc82818d67AF737725bD4bf75435d065D239;

/**
 * @title TokenBridgeOftArbForkTest
 * @notice Fork tests against USDT0 OFT on Arbitrum (burn/mint pattern).
 * @dev Run with: forge test --match-contract TokenBridgeOftArbForkTest --fork-url $RPC_URL_ARBITRUM -vvv
 */
contract TokenBridgeOftArbForkTest is Test {
    // USDT0 OFT on Arbitrum (burn/mint, approvalRequired=false)
    address constant USDT0_OFT = 0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92;
    address constant USDT0_TOKEN = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;

    // LayerZero endpoint IDs
    uint32 constant LZ_EID_ETHEREUM = 30101;

    // Hyperlane domain IDs
    uint32 constant HYP_DOMAIN_ETHEREUM = 1;

    uint256 constant AMOUNT = 100e6; // 100 USDT0 (6 decimals)

    TokenBridgeOft internal bridge;
    address internal caller = makeAddr("caller");
    bytes32 internal recipient =
        bytes32(uint256(uint160(makeAddr("recipient"))));

    function setUp() public {
        bridge = new TokenBridgeOft(USDT0_OFT, MAILBOX_ARBITRUM);
        bridge.initialize(address(0), address(0), address(this));
        bridge.addDomain(HYP_DOMAIN_ETHEREUM, LZ_EID_ETHEREUM);
        vm.deal(caller, 1 ether);
    }

    function test_constructor() public view {
        assertEq(address(bridge.oft()), USDT0_OFT);
        assertEq(bridge.token(), USDT0_TOKEN);
        assertEq(bridge.refundAddress(), address(this));
    }

    function test_oftInterface() public view {
        (bytes4 interfaceId, uint64 version) = IOFT(USDT0_OFT).oftVersion();
        assertEq(interfaceId, bytes4(0x02e49c2c), "IOFT interface ID");
        assertEq(version, 1, "OFT version");

        assertEq(IOFT(USDT0_OFT).token(), USDT0_TOKEN);
        assertFalse(
            IOFT(USDT0_OFT).approvalRequired(),
            "burn/mint OFT should not require approval"
        );
        assertEq(IOFT(USDT0_OFT).sharedDecimals(), 6);
    }

    function test_quoteTransferRemote() public view {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            HYP_DOMAIN_ETHEREUM,
            recipient,
            AMOUNT
        );

        // TokenRouter returns 3 quotes: [native gas, token fee, external fee]
        assertEq(quotes.length, 3, "should have 3 quotes");
        assertEq(quotes[0].token, address(0), "gas fee should be native");
        assertGt(quotes[0].amount, 0, "native fee > 0");
    }

    function test_quoteOftFees() public view {
        SendParam memory sendParam = SendParam({
            dstEid: LZ_EID_ETHEREUM,
            to: recipient,
            amountLD: AMOUNT,
            minAmountLD: 0,
            extraOptions: "",
            composeMsg: "",
            oftCmd: ""
        });

        (OFTLimit memory limit, , OFTReceipt memory receipt) = IOFT(USDT0_OFT)
            .quoteOFT(sendParam);

        // USDT0 may charge token-level fees
        assertGe(
            receipt.amountSentLD,
            receipt.amountReceivedLD,
            "sent >= received"
        );
        assertGt(limit.maxAmountLD, 0, "max amount > 0");
    }

    function test_transferRemote() public {
        // Deal USDT0 to caller via the OFT's token
        deal(USDT0_TOKEN, caller, AMOUNT);

        // Get quote
        Quote[] memory quotes = bridge.quoteTransferRemote(
            HYP_DOMAIN_ETHEREUM,
            recipient,
            AMOUNT
        );
        uint256 nativeFee = quotes[0].amount;

        vm.startPrank(caller);

        // Approve bridge to pull tokens
        IERC20(USDT0_TOKEN).approve(address(bridge), AMOUNT);

        // Execute transfer
        bytes32 guid = bridge.transferRemote{value: nativeFee}(
            HYP_DOMAIN_ETHEREUM,
            recipient,
            AMOUNT
        );

        vm.stopPrank();

        assertNotEq(guid, bytes32(0), "guid non-zero");
        assertEq(
            IERC20(USDT0_TOKEN).balanceOf(caller),
            0,
            "tokens pulled from caller"
        );
    }

    // ============ Error Cases ============

    function test_revert_unconfiguredDomain() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridgeOft.LzEidNotConfigured.selector,
                uint32(999)
            )
        );
        bridge.quoteTransferRemote(999, recipient, AMOUNT);
    }

    function test_revert_zeroAddressOft() public {
        vm.expectRevert("TokenBridgeOft: zero OFT address");
        new TokenBridgeOft(address(0), MAILBOX_ARBITRUM);
    }

    // ============ Admin ============

    function test_addRemoveDomain() public {
        bridge.addDomain(100, 30200);
        assertEq(bridge.hyperlaneDomainToLzEid(100), 30200);

        bridge.removeDomain(100);
        assertEq(bridge.hyperlaneDomainToLzEid(100), 0);
    }

    function test_setExtraOptions() public {
        bytes memory opts = hex"deadbeef";
        bridge.setExtraOptions(opts);
        assertEq(bridge.extraOptions(), opts);
    }

    function test_setRefundAddress() public {
        address newRefund = makeAddr("newRefund");
        bridge.setRefundAddress(newRefund);
        assertEq(bridge.refundAddress(), newRefund);
    }

    function test_revert_setRefundAddressZero() public {
        vm.expectRevert("TokenBridgeOft: zero refund address");
        bridge.setRefundAddress(address(0));
    }

    function test_revert_nonOwnerAddDomain() public {
        vm.prank(caller);
        vm.expectRevert("Ownable: caller is not the owner");
        bridge.addDomain(100, 30200);
    }
}

/**
 * @title TokenBridgeOftEthForkTest
 * @notice Fork tests against USDT0 OFT Adapter on Ethereum (lock/unlock pattern).
 * @dev Run with: forge test --match-contract TokenBridgeOftEthForkTest --fork-url $RPC_URL_MAINNET -vvv
 */
contract TokenBridgeOftEthForkTest is Test {
    using SafeERC20 for IERC20;
    // USDT0 OFT Adapter on Ethereum (lock/unlock, approvalRequired=true)
    address constant USDT0_OFT_ADAPTER =
        0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee;
    address constant USDT_TOKEN = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    // Binance hot wallet — USDT whale for impersonation
    address constant USDT_WHALE = 0xF977814e90dA44bFA03b6295A0616a897441aceC;

    // LayerZero endpoint IDs
    uint32 constant LZ_EID_ARBITRUM = 30110;

    // Hyperlane domain IDs
    uint32 constant HYP_DOMAIN_ARBITRUM = 42161;

    uint256 constant AMOUNT = 100e6; // 100 USDT (6 decimals)

    TokenBridgeOft internal bridge;
    bytes32 internal recipient =
        bytes32(uint256(uint160(makeAddr("recipient"))));

    function setUp() public {
        bridge = new TokenBridgeOft(USDT0_OFT_ADAPTER, MAILBOX_ETHEREUM);
        bridge.initialize(address(0), address(0), address(this));
        bridge.addDomain(HYP_DOMAIN_ARBITRUM, LZ_EID_ARBITRUM);
        vm.deal(USDT_WHALE, 1 ether);
    }

    function test_constructor_adapter() public view {
        assertEq(address(bridge.oft()), USDT0_OFT_ADAPTER);
        assertEq(bridge.token(), USDT_TOKEN);
        assertEq(bridge.refundAddress(), address(this));

        // OFT Adapter should have max approval set in constructor
        uint256 allowance = IERC20(USDT_TOKEN).allowance(
            address(bridge),
            USDT0_OFT_ADAPTER
        );
        assertGt(allowance, 0, "bridge should have approved OFT adapter");
    }

    function test_oftAdapterInterface() public view {
        (bytes4 interfaceId, uint64 version) = IOFT(USDT0_OFT_ADAPTER)
            .oftVersion();
        assertEq(interfaceId, bytes4(0x02e49c2c), "IOFT interface ID");
        assertEq(version, 1, "OFT version");

        assertEq(IOFT(USDT0_OFT_ADAPTER).token(), USDT_TOKEN);
        assertTrue(
            IOFT(USDT0_OFT_ADAPTER).approvalRequired(),
            "adapter should require approval"
        );
    }

    function test_quoteTransferRemote() public view {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            HYP_DOMAIN_ARBITRUM,
            recipient,
            AMOUNT
        );

        assertEq(quotes.length, 3, "should have 3 quotes");
        assertEq(quotes[0].token, address(0), "gas fee should be native");
        assertGt(quotes[0].amount, 0, "native fee > 0");
    }

    function test_transferRemote() public {
        // Get quote
        Quote[] memory quotes = bridge.quoteTransferRemote(
            HYP_DOMAIN_ARBITRUM,
            recipient,
            AMOUNT
        );
        uint256 nativeFee = quotes[0].amount;

        uint256 balBefore = IERC20(USDT_TOKEN).balanceOf(USDT_WHALE);

        vm.startPrank(USDT_WHALE);

        // Use safeApprove — USDT's approve() returns void (non-standard)
        IERC20(USDT_TOKEN).safeApprove(address(bridge), AMOUNT);

        // Execute transfer — locks USDT in the OFT adapter
        bytes32 guid = bridge.transferRemote{value: nativeFee}(
            HYP_DOMAIN_ARBITRUM,
            recipient,
            AMOUNT
        );

        vm.stopPrank();

        assertNotEq(guid, bytes32(0), "guid non-zero");
        assertEq(
            IERC20(USDT_TOKEN).balanceOf(USDT_WHALE),
            balBefore - AMOUNT,
            "tokens pulled from whale"
        );
    }
}

/**
 * @title TokenBridgeOftPyusdArbForkTest
 * @notice Fork tests against pyUSD OFTWrapper on Arbitrum (burn/mint via Paxos OFTWrapper).
 * @dev Paxos uses a custom OFTWrapper (not standard OFTAdapter) that burns/mints directly.
 *      approvalRequired=false because the wrapper has mint/burn permissions on the token.
 *      Run with: forge test --match-contract TokenBridgeOftPyusdArbForkTest --fork-url $RPC_URL_ARBITRUM -vvv
 */
contract TokenBridgeOftPyusdArbForkTest is Test {
    // Paxos OFTWrapper on Arbitrum (burn/mint, approvalRequired=false)
    address constant PYUSD_OFT = 0xFaB5891ED867a1195303251912013b92c4fc3a1D;
    address constant PYUSD_TOKEN = 0x46850aD61C2B7d64d08c9C754F45254596696984;

    uint32 constant LZ_EID_ETHEREUM = 30101;
    uint32 constant HYP_DOMAIN_ETHEREUM = 1;

    uint256 constant AMOUNT = 100e6; // 100 pyUSD (6 decimals)

    TokenBridgeOft internal bridge;
    address internal caller = makeAddr("caller");
    bytes32 internal recipient =
        bytes32(uint256(uint160(makeAddr("recipient"))));

    function setUp() public {
        bridge = new TokenBridgeOft(PYUSD_OFT, MAILBOX_ARBITRUM);
        bridge.initialize(address(0), address(0), address(this));
        bridge.addDomain(HYP_DOMAIN_ETHEREUM, LZ_EID_ETHEREUM);
        vm.deal(caller, 1 ether);
    }

    function test_constructor() public view {
        assertEq(address(bridge.oft()), PYUSD_OFT);
        assertEq(bridge.token(), PYUSD_TOKEN);
    }

    function test_oftInterface() public view {
        (bytes4 interfaceId, uint64 version) = IOFT(PYUSD_OFT).oftVersion();
        assertEq(interfaceId, bytes4(0x02e49c2c), "IOFT interface ID");
        assertEq(version, 1, "OFT version");

        assertEq(IOFT(PYUSD_OFT).token(), PYUSD_TOKEN);
        assertFalse(
            IOFT(PYUSD_OFT).approvalRequired(),
            "OFTWrapper should not require approval"
        );
        assertEq(IOFT(PYUSD_OFT).sharedDecimals(), 6);
    }

    function test_quoteTransferRemote() public view {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            HYP_DOMAIN_ETHEREUM,
            recipient,
            AMOUNT
        );

        assertEq(quotes.length, 3, "should have 3 quotes");
        assertEq(quotes[0].token, address(0), "gas fee should be native");
        assertGt(quotes[0].amount, 0, "native fee > 0");
    }

    function test_quoteOftNoTokenFees() public view {
        SendParam memory sendParam = SendParam({
            dstEid: LZ_EID_ETHEREUM,
            to: recipient,
            amountLD: AMOUNT,
            minAmountLD: 0,
            extraOptions: "",
            composeMsg: "",
            oftCmd: ""
        });

        (, , OFTReceipt memory receipt) = IOFT(PYUSD_OFT).quoteOFT(sendParam);

        // pyUSD should not charge token-level fees
        assertEq(
            receipt.amountSentLD,
            receipt.amountReceivedLD,
            "pyUSD should have no token-level fees"
        );
    }

    function test_transferRemote() public {
        // Deal pyUSD to caller
        deal(PYUSD_TOKEN, caller, AMOUNT);

        Quote[] memory quotes = bridge.quoteTransferRemote(
            HYP_DOMAIN_ETHEREUM,
            recipient,
            AMOUNT
        );
        uint256 nativeFee = quotes[0].amount;

        vm.startPrank(caller);
        IERC20(PYUSD_TOKEN).approve(address(bridge), AMOUNT);

        bytes32 guid = bridge.transferRemote{value: nativeFee}(
            HYP_DOMAIN_ETHEREUM,
            recipient,
            AMOUNT
        );
        vm.stopPrank();

        assertNotEq(guid, bytes32(0), "guid non-zero");
        assertEq(
            IERC20(PYUSD_TOKEN).balanceOf(caller),
            0,
            "tokens pulled from caller"
        );
    }
}

/**
 * @title TokenBridgeOftPyusdEthForkTest
 * @notice Fork tests against pyUSD OFTWrapper on Ethereum (burn/mint via Paxos OFTWrapper).
 * @dev Run with: forge test --match-contract TokenBridgeOftPyusdEthForkTest --fork-url $RPC_URL_MAINNET -vvv
 */
contract TokenBridgeOftPyusdEthForkTest is Test {
    // Paxos OFTWrapper on Ethereum (burn/mint, approvalRequired=false)
    address constant PYUSD_OFT = 0xa2C323fE5A74aDffAd2bf3E007E36bb029606444;
    address constant PYUSD_TOKEN = 0x6c3ea9036406852006290770BEdFcAbA0e23A0e8;

    uint32 constant LZ_EID_ARBITRUM = 30110;
    uint32 constant HYP_DOMAIN_ARBITRUM = 42161;

    uint256 constant AMOUNT = 100e6; // 100 pyUSD (6 decimals)

    TokenBridgeOft internal bridge;
    address internal caller = makeAddr("caller");
    bytes32 internal recipient =
        bytes32(uint256(uint160(makeAddr("recipient"))));

    function setUp() public {
        bridge = new TokenBridgeOft(PYUSD_OFT, MAILBOX_ETHEREUM);
        bridge.initialize(address(0), address(0), address(this));
        bridge.addDomain(HYP_DOMAIN_ARBITRUM, LZ_EID_ARBITRUM);
        vm.deal(caller, 1 ether);
    }

    function test_constructor() public view {
        assertEq(address(bridge.oft()), PYUSD_OFT);
        assertEq(bridge.token(), PYUSD_TOKEN);
    }

    function test_oftInterface() public view {
        (bytes4 interfaceId, uint64 version) = IOFT(PYUSD_OFT).oftVersion();
        assertEq(interfaceId, bytes4(0x02e49c2c), "IOFT interface ID");
        assertEq(version, 1, "OFT version");

        assertEq(IOFT(PYUSD_OFT).token(), PYUSD_TOKEN);
        assertFalse(
            IOFT(PYUSD_OFT).approvalRequired(),
            "OFTWrapper should not require approval"
        );
    }

    function test_quoteTransferRemote() public view {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            HYP_DOMAIN_ARBITRUM,
            recipient,
            AMOUNT
        );

        assertEq(quotes.length, 3, "should have 3 quotes");
        assertEq(quotes[0].token, address(0), "gas fee should be native");
        assertGt(quotes[0].amount, 0, "native fee > 0");
    }

    function test_transferRemote() public {
        deal(PYUSD_TOKEN, caller, AMOUNT);

        Quote[] memory quotes = bridge.quoteTransferRemote(
            HYP_DOMAIN_ARBITRUM,
            recipient,
            AMOUNT
        );
        uint256 nativeFee = quotes[0].amount;

        vm.startPrank(caller);
        IERC20(PYUSD_TOKEN).approve(address(bridge), AMOUNT);

        bytes32 guid = bridge.transferRemote{value: nativeFee}(
            HYP_DOMAIN_ARBITRUM,
            recipient,
            AMOUNT
        );
        vm.stopPrank();

        assertNotEq(guid, bytes32(0), "guid non-zero");
        assertEq(
            IERC20(PYUSD_TOKEN).balanceOf(caller),
            0,
            "tokens pulled from caller"
        );
    }
}
