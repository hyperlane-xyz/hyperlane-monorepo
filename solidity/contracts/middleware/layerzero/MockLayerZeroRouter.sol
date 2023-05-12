// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "../../Router.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";
import {ILayerZeroEndpoint} from "../../interfaces/middleware/layerzero/ILayerZeroEndpoint.sol";
import {ILayerZeroReceiver} from "../../interfaces/middleware/layerzero/ILayerZeroReceiver.sol";
import {LayerZeroRouter} from "./LayerZeroRouter.sol";

/**
 * @title MockLayerZeroRouter
 * @dev Used for testing LayerZeroRouter
 */

contract MockLayerZeroRouter is LayerZeroRouter {
    /**
     * @notice Originally LayerZero endpoint which will be evoked by this contract's handle function
     * @dev override from ILayerZeroEndpoint.sol -- NEED UPDATING
     * @param _srcChainId - the source endpoint identifier
     * @param _srcAddress - the source sending contract address from the source chain
     * @param _nonce - the ordered message nonce (not used in Hyperlane)
     * @param _payload - the signed payload is the UA bytes has encoded to be sent
     */
    function lzReceive(
        uint16 _srcChainId,
        bytes32 _srcAddress,
        uint64 _nonce,
        bytes memory _payload
    ) public override {}

    /**
     * @dev Below are the functions that are not supported in the interface "ILayerZeroEndpoint" due to way hyperlane is structured
     */

    function receivePayload(
        uint16 _srcChainId,
        bytes calldata _srcAddress,
        address _dstAddress,
        uint64 _nonce,
        uint256 _gasLimit,
        bytes calldata _payload
    ) external override {
        //Not supported
    }

    function getInboundNonce(uint16 _srcChainId, bytes calldata _srcAddress)
        external
        view
        override
        returns (uint64)
    {
        //Not supported
        return 0;
    }

    function retryPayload(
        uint16 _srcChainId,
        bytes calldata _srcAddress,
        bytes calldata _payload
    ) external override {
        //Not supported
    }

    function hasStoredPayload(uint16 _srcChainId, bytes calldata _srcAddress)
        external
        view
        override
        returns (bool)
    {
        //Not supported
        return false;
    }

    function getSendLibraryAddress(address _userApplication)
        external
        view
        override
        returns (address)
    {
        //Not supported
        return address(0);
    }

    function getReceiveLibraryAddress(address _userApplication)
        external
        view
        override
        returns (address)
    {
        //Not supported
        return address(0);
    }

    function isSendingPayload() external view override returns (bool) {
        //Not supported
        return false;
    }

    function isReceivingPayload() external view override returns (bool) {
        //Not supported
        return false;
    }

    function getConfig(
        uint16 _version,
        uint16 _chainId,
        address _userApplication,
        uint256 _configType
    ) external view returns (bytes memory) {
        //Not supported
        return "";
    }

    function getSendVersion(address _userApplication)
        external
        view
        override
        returns (uint16)
    {
        //Not supported
        return 0;
    }

    function getReceiveVersion(address _userApplication)
        external
        view
        override
        returns (uint16)
    {
        //Not supported
        return 0;
    }

    /**
     * @dev Below are the functions that are not supported in the interface "ILayerZeroUserApplicationConfig" due to way hyperlane is structured
     */
    function setConfig(
        uint16 _version,
        uint16 _chainId,
        uint256 _configType,
        bytes calldata _config
    ) external override {
        //Not supported
    }

    function setSendVersion(uint16 _version) external override {
        //Not supported
    }

    function setReceiveVersion(uint16 _version) external override {
        //Not supported
    }

    function forceResumeReceive(uint16 _srcChainId, bytes calldata _srcAddress)
        external
        override
    {
        //Not supported
    }
}
