// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {LZEndpointMock} from "@layerzerolabs/solidity-examples/contracts/lzApp/mocks/LZEndpointMock.sol";
import {OmniCounter} from "@layerzerolabs/solidity-examples/contracts/examples/OmniCounter.sol";
import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../../contracts/hooks/libs/StandardHookMetadata.sol";
import {TestMailbox} from "../../../contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "../../../contracts/test/TestPostDispatchHook.sol";
import {LayerZeroV1Hook, LayerZeroMetadata} from "../../../contracts/hooks/layerzero/LayerZeroV1Hook.sol";
import {IPostDispatchHook} from "../../../contracts/interfaces/hooks/IPostDispatchHook.sol";

import "forge-std/console.sol";

contract LayerZeroV1HookTest is Test {
    using TypeCasts for address;

    OmniCounter crossChainCounterApp;
    LZEndpointMock lZEndpointMock;
    TestMailbox public mailbox;
    TestPostDispatchHook requiredHook;
    LayerZeroV1Hook hook;
    address alice = makeAddr("alice");

    function setUp() public {
        lZEndpointMock = new LZEndpointMock(uint16(block.chainid));
        crossChainCounterApp = new OmniCounter(address(lZEndpointMock));
        requiredHook = new TestPostDispatchHook();
        mailbox = new TestMailbox(0);
        hook = new LayerZeroV1Hook(address(mailbox), address(lZEndpointMock));

        mailbox.setRequiredHook(address(requiredHook));

        // Sets the endpoint destinations
        lZEndpointMock.setDestLzEndpoint(
            address(crossChainCounterApp),
            address(lZEndpointMock)
        );

        // set hook as a trusted remote
        crossChainCounterApp.setTrustedRemote(
            uint16(block.chainid),
            abi.encodePacked(address(hook), address(crossChainCounterApp))
        );
    }

    function testParseLzMetadata_returnsCorrectData() public {
        // format Lz metadata
        uint16 dstChainId = uint16(block.chainid);
        address userApplication = address(crossChainCounterApp);
        address refundAddress = alice;
        bytes memory payload = "Hello World!";
        bytes memory destination = abi.encodePacked(
            userApplication,
            address(lZEndpointMock)
        ); // remoteAndLocalAddresses
        bytes memory adapterParam = "";
        LayerZeroMetadata memory layerZeroMetadata = LayerZeroMetadata(
            dstChainId,
            userApplication,
            refundAddress,
            payload,
            destination,
            adapterParam
        );
        bytes memory formattedMetadata = hook.formatLzMetadata(
            layerZeroMetadata
        );

        (
            uint16 _dstChainId,
            address _userApplication,
            address _refundAddress,
            bytes memory _payload,
            bytes memory _destination,
            bytes memory _adapterParam
        ) = hook.parseLzMetadata(formattedMetadata);
        assertEq(_dstChainId, dstChainId);
        assertEq(_userApplication, userApplication);
        assertEq(_refundAddress, refundAddress);
        assertEq(_payload, payload);
        assertEq(_destination, destination);
        assertEq(_adapterParam, adapterParam);
    }

    function testQuoteDispatch_returnsFeeAmount()
        public
        returns (uint256 nativeFee, bytes memory metadata)
    {
        // Build metadata to include LZ-specific data
        uint16 dstChainId = uint16(block.chainid);
        address userApplication = address(crossChainCounterApp);
        address refundAddress = alice;
        bytes memory payload = "Hello World!";
        bytes memory destination = abi.encodePacked(
            userApplication,
            address(lZEndpointMock)
        ); // remoteAndLocalAddresses
        bytes memory adapterParam = "";
        LayerZeroMetadata memory layerZeroMetadata = LayerZeroMetadata(
            dstChainId,
            userApplication,
            refundAddress,
            payload,
            destination,
            adapterParam
        );
        bytes memory formattedLzMetadata = hook.formatLzMetadata(
            layerZeroMetadata
        );
        metadata = StandardHookMetadata.formatMetadata(
            0,
            0,
            refundAddress,
            formattedLzMetadata
        );
        bytes memory message = mailbox.buildOutboundMessage(
            0,
            address(lZEndpointMock).addressToBytes32(),
            payload
        );
        nativeFee = hook.quoteDispatch(metadata, message);

        // It costs something
        assertGt(nativeFee, 0);
    }

    function testPostDispatch_executesCrossChain() public {
        (
            uint256 nativeFee,
            bytes memory metadata
        ) = testQuoteDispatch_returnsFeeAmount();

        // dispatch also executes L0 call to increment counter
        assertEq(crossChainCounterApp.counter(), 0);
        mailbox.dispatch{value: nativeFee}(
            0,
            address(crossChainCounterApp).addressToBytes32(),
            "Hello World!",
            metadata,
            hook
        );
        assertEq(crossChainCounterApp.counter(), 1);
    }

    function testPostDispatch_notEnoughFee() public {
        (
            uint256 nativeFee,
            bytes memory metadata
        ) = testQuoteDispatch_returnsFeeAmount();

        vm.expectRevert("LayerZeroMock: not enough native for fees");
        mailbox.dispatch{value: nativeFee - 1}(
            0,
            address(crossChainCounterApp).addressToBytes32(),
            "Hello World!",
            metadata,
            hook
        );
    }

    function testPostDispatch_refundExtraFee() public {
        (
            uint256 nativeFee,
            bytes memory metadata
        ) = testQuoteDispatch_returnsFeeAmount();

        uint256 balanceBefore = address(alice).balance;
        mailbox.dispatch{value: nativeFee + 1}(
            0,
            address(crossChainCounterApp).addressToBytes32(),
            "Hello World!",
            metadata,
            hook
        );
        uint256 balanceAfter = address(alice).balance;

        assertEq(balanceAfter, balanceBefore + 1);
    }

    // TODO test failed/retry
    function testHookType() public {
        assertEq(hook.hookType(), uint8(IPostDispatchHook.Types.LAYER_ZERO));
    }
}
