// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {ERC20Test} from "@hyperlane-xyz/core/test/ERC20Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AggLayerTokenBridge} from "../contracts/AggLayerTokenBridge.sol";
import {IAggLayerBridge} from "../contracts/interfaces/IAggLayerBridge.sol";
import {Quote} from "@hyperlane-xyz/core/interfaces/ITokenBridge.sol";

contract MockAggLayerBridge is IAggLayerBridge {
    event BridgeAssetCalled(
        uint32 destinationNetwork,
        address destinationAddress,
        uint256 amount,
        address token,
        bool forceUpdateGlobalExitRoot,
        bytes permitData,
        uint256 value
    );

    uint32 public lastDestinationNetwork;
    address public lastDestinationAddress;
    uint256 public lastAmount;
    address public lastToken;
    bool public lastForce;
    bytes public lastPermitData;
    uint256 public lastValue;

    function bridgeAsset(
        uint32 destinationNetwork,
        address destinationAddress,
        uint256 amount,
        address token,
        bool forceUpdateGlobalExitRoot,
        bytes calldata permitData
    ) external payable override {
        IERC20(token).transferFrom(msg.sender, address(this), amount);

        lastDestinationNetwork = destinationNetwork;
        lastDestinationAddress = destinationAddress;
        lastAmount = amount;
        lastToken = token;
        lastForce = forceUpdateGlobalExitRoot;
        lastPermitData = permitData;
        lastValue = msg.value;

        emit BridgeAssetCalled(
            destinationNetwork,
            destinationAddress,
            amount,
            token,
            forceUpdateGlobalExitRoot,
            permitData,
            msg.value
        );
    }
}

contract AggLayerTokenBridgeTest is Test {
    uint32 internal constant ETHEREUM_DOMAIN = 1;
    uint32 internal constant KATANA_DOMAIN = 747474;
    uint32 internal constant ETHEREUM_NETWORK_ID = 0;
    uint32 internal constant KATANA_NETWORK_ID = 20;

    address internal constant OWNER = address(0x100);
    address internal constant ALICE = address(0x101);
    bytes32 internal constant RECIPIENT =
        bytes32(uint256(uint160(address(0xBEEF))));

    ERC20Test internal token;
    MockAggLayerBridge internal agglayer;
    AggLayerTokenBridge internal bridge;

    function setUp() public {
        token = new ERC20Test("Token", "TOK", 0, 6);
        agglayer = new MockAggLayerBridge();
        bridge = new AggLayerTokenBridge(
            address(token),
            address(agglayer),
            OWNER,
            false
        );

        vm.startPrank(OWNER);
        bridge.setDestinationDomain(KATANA_DOMAIN, KATANA_NETWORK_ID);
        bridge.setDestinationDomain(ETHEREUM_DOMAIN, ETHEREUM_NETWORK_ID);
        bridge.setFeeConfig(KATANA_DOMAIN, 0.01 ether, 5e6);
        vm.stopPrank();

        vm.deal(ALICE, 1 ether);
    }

    function test_quoteTransferRemote() public {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            KATANA_DOMAIN,
            RECIPIENT,
            100e6
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 0.01 ether);
        assertEq(quotes[1].token, address(token));
        assertEq(quotes[1].amount, 105e6);
    }

    function test_transferRemote() public {
        token.mintTo(ALICE, 1_000e6);

        vm.prank(ALICE);
        token.approve(address(bridge), type(uint256).max);

        vm.prank(ALICE);
        bridge.transferRemote{value: 0.01 ether}(
            KATANA_DOMAIN,
            RECIPIENT,
            100e6
        );

        assertEq(agglayer.lastDestinationNetwork(), KATANA_NETWORK_ID);
        assertEq(
            agglayer.lastDestinationAddress(),
            address(uint160(uint256(RECIPIENT)))
        );
        assertEq(agglayer.lastAmount(), 100e6);
        assertEq(agglayer.lastToken(), address(token));
        assertEq(agglayer.lastForce(), false);
        assertEq(agglayer.lastValue(), 0.01 ether);

        // bridged amount approved/used; token fee retained on adapter
        assertEq(token.balanceOf(address(bridge)), 5e6);
    }

    function test_transferRemote_revertWhenDestinationNotConfigured() public {
        token.mintTo(ALICE, 100e6);

        vm.prank(ALICE);
        token.approve(address(bridge), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(
                AggLayerTokenBridge.DestinationDomainNotConfigured.selector,
                uint32(999999)
            )
        );
        vm.prank(ALICE);
        bridge.transferRemote(999999, RECIPIENT, 100e6);
    }

    function test_transferRemote_revertWhenInvalidRecipient() public {
        token.mintTo(ALICE, 100e6);

        vm.prank(ALICE);
        token.approve(address(bridge), type(uint256).max);

        bytes32 malformed = bytes32(type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                AggLayerTokenBridge.InvalidRecipient.selector,
                malformed
            )
        );

        vm.prank(ALICE);
        bridge.transferRemote{value: 0.01 ether}(
            KATANA_DOMAIN,
            malformed,
            100e6
        );
    }

    function test_transferRemote_revertWhenNativeFeeMismatch() public {
        token.mintTo(ALICE, 100e6);

        vm.prank(ALICE);
        token.approve(address(bridge), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(
                AggLayerTokenBridge.NativeFeeMismatch.selector,
                0.01 ether,
                0
            )
        );

        vm.prank(ALICE);
        bridge.transferRemote(KATANA_DOMAIN, RECIPIENT, 100e6);
    }

    function test_transferRemote_revertWhenInsufficientAllowance() public {
        token.mintTo(ALICE, 200e6);

        vm.prank(ALICE);
        token.approve(address(bridge), 50e6);

        vm.expectRevert("ERC20: insufficient allowance");
        vm.prank(ALICE);
        bridge.transferRemote{value: 0.01 ether}(
            KATANA_DOMAIN,
            RECIPIENT,
            100e6
        );
    }

    function test_transferRemote_revertWhenInsufficientBalance() public {
        token.mintTo(ALICE, 80e6);

        vm.prank(ALICE);
        token.approve(address(bridge), type(uint256).max);

        vm.expectRevert("ERC20: transfer amount exceeds balance");
        vm.prank(ALICE);
        bridge.transferRemote{value: 0.01 ether}(
            KATANA_DOMAIN,
            RECIPIENT,
            100e6
        );
    }
}

contract AggLayerTokenBridgeForkTest is Test {
    uint32 internal constant ETHEREUM_DOMAIN = 1;
    uint32 internal constant KATANA_DOMAIN = 747474;
    uint32 internal constant ETHEREUM_NETWORK_ID = 0;
    uint32 internal constant KATANA_NETWORK_ID = 20;

    address internal constant UNIFIED_BRIDGE =
        0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe;

    // Katana vault bridge assets (vbUSDC / vbUSDT)
    address internal constant KATANA_VBUSDC =
        0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36;
    address internal constant KATANA_VBUSDT =
        0x2DCa96907fde857dd3D816880A0df407eeB2D2F2;

    // Ethereum vault bridge assets (vbUSDC / vbUSDT)
    address internal constant ETH_VBUSDC =
        0x53E82ABbb12638F09d9e624578ccB666217a765e;
    address internal constant ETH_VBUSDT =
        0x6d4f9f9f8f0155509ecd6Ac6c544fF27999845CC;

    address internal constant OWNER = address(0x100);
    address internal constant ALICE = address(0x101);
    bytes32 internal constant RECIPIENT =
        bytes32(uint256(uint160(address(0xBEEF))));

    function testFork_transferRemote_katanaToEthereum_usdc() public {
        vm.createSelectFork("katana");
        _forkTransferSmoke(KATANA_VBUSDC, ETHEREUM_DOMAIN, ETHEREUM_NETWORK_ID);
    }

    function testFork_transferRemote_katanaToEthereum_usdt() public {
        vm.createSelectFork("katana");
        _forkTransferSmoke(KATANA_VBUSDT, ETHEREUM_DOMAIN, ETHEREUM_NETWORK_ID);
    }

    function testFork_transferRemote_ethereumToKatana_usdc() public {
        vm.createSelectFork("mainnet");
        _forkTransferSmoke(ETH_VBUSDC, KATANA_DOMAIN, KATANA_NETWORK_ID);
    }

    function testFork_transferRemote_ethereumToKatana_usdt() public {
        vm.createSelectFork("mainnet");
        _forkTransferSmoke(ETH_VBUSDT, KATANA_DOMAIN, KATANA_NETWORK_ID);
    }

    function _forkTransferSmoke(
        address tokenAddress,
        uint32 destinationDomain,
        uint32 destinationNetwork
    ) internal {
        // Ensure bridge/token addresses are contracts on the fork.
        assertGt(tokenAddress.code.length, 0, "token has no code");
        assertGt(UNIFIED_BRIDGE.code.length, 0, "unified bridge has no code");

        AggLayerTokenBridge bridge = new AggLayerTokenBridge(
            tokenAddress,
            UNIFIED_BRIDGE,
            OWNER,
            false
        );

        vm.prank(OWNER);
        bridge.setDestinationDomain(destinationDomain, destinationNetwork);

        // Stub bridge call to keep fork tests deterministic while still validating call path and params.
        vm.mockCall(
            UNIFIED_BRIDGE,
            abi.encodeWithSignature(
                "bridgeAsset(uint32,address,uint256,address,bool,bytes)",
                destinationNetwork,
                address(uint160(uint256(RECIPIENT))),
                uint256(10e6),
                tokenAddress,
                false,
                bytes("")
            ),
            ""
        );

        deal(tokenAddress, ALICE, 100e6, true);

        vm.startPrank(ALICE);
        IERC20(tokenAddress).approve(address(bridge), type(uint256).max);
        bridge.transferRemote(destinationDomain, RECIPIENT, 10e6);
        vm.stopPrank();

        // On fork tests we mock the AggLayer bridge call, so the bridged amount
        // remains on the adapter instead of being pulled by the bridge contract.
        assertEq(IERC20(tokenAddress).balanceOf(address(bridge)), 10e6);
    }
}
