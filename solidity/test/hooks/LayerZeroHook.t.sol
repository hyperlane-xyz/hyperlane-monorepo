// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {LZEndpointMock} from "@layerzerolabs/solidity-examples/contracts/lzApp/mocks/LZEndpointMock.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {LayerZeroHook, LayerZeroMetadata} from "../../contracts/hooks/LayerZeroHook.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";

contract LayerZeroHookTest is Test {
    LZEndpointMock lZEndpointMock;
    TestMailbox public mailbox;
    LayerZeroHook hook;

    function setUp() public {
        lZEndpointMock = new LZEndpointMock(uint16(block.chainid));
        mailbox = new TestMailbox(0);
        hook = new LayerZeroHook(address(mailbox), address(lZEndpointMock));
    }

    function testParseLzMetadata_returnsCorrectData() public {
        // format metadata
        uint16 dstChainId = uint16(block.chainid);
        address userApplication = makeAddr("user app");
        address refundAddress = address(this);
        bytes memory payload = "";
        bytes memory destination = "";
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

    function testQuoteDispatch_returnsCorrectData() public {
        // Build metadata to include LZ-specific data
        // format metadata
        uint16 dstChainId = uint16(block.chainid);
        address userApplication = makeAddr("user app");
        address refundAddress = address(this);
        bytes memory payload = "";
        bytes memory destination = "";
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
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            0,
            0,
            refundAddress,
            formattedMetadata
        );

        assertEq(hook.quoteDispatch(metadata, ""), 252);
    }

    function testHookType() public {
        assertEq(hook.hookType(), uint8(IPostDispatchHook.Types.LAYER_ZERO));
    }
}
