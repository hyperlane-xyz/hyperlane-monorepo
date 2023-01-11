// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {IPortalTokenBridge} from "../middleware/liquidity-layer/interfaces/portal/IPortalTokenBridge.sol";
import {MockToken} from "./MockToken.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

contract MockPortalBridge is IPortalTokenBridge {
    uint256 nextNonce = 0;
    MockToken token;

    constructor(MockToken _token) {
        token = _token;
    }

    function transferTokensWithPayload(
        address,
        uint256 amount,
        uint16,
        bytes32,
        uint32,
        bytes memory
    ) external payable returns (uint64 sequence) {
        nextNonce = nextNonce + 1;
        token.transferFrom(msg.sender, address(this), amount);
        token.burn(amount);
        return uint64(nextNonce);
    }

    function wrappedAsset(uint16, bytes32) external view returns (address) {
        return address(token);
    }

    function isWrappedAsset(address) external pure returns (bool) {
        return true;
    }

    function completeTransferWithPayload(bytes memory encodedVm)
        external
        returns (bytes memory)
    {
        (uint32 _originDomain, uint224 _nonce, uint256 _amount) = abi.decode(
            encodedVm,
            (uint32, uint224, uint256)
        );

        token.mint(msg.sender, _amount);
        // Format it so that parseTransferWithPayload returns the desired payload
        return
            abi.encode(
                TypeCasts.addressToBytes32(address(token)),
                adapterData(_originDomain, _nonce, address(token))
            );
    }

    function parseTransferWithPayload(bytes memory encoded)
        external
        pure
        returns (TransferWithPayload memory transfer)
    {
        (bytes32 tokenAddress, bytes memory payload) = abi.decode(
            encoded,
            (bytes32, bytes)
        );
        transfer.payload = payload;
        transfer.tokenAddress = tokenAddress;
    }

    function adapterData(
        uint32 _originDomain,
        uint224 _nonce,
        address _token
    ) public pure returns (bytes memory) {
        return
            abi.encode(
                _originDomain,
                _nonce,
                TypeCasts.addressToBytes32(_token)
            );
    }

    function mockPortalVaa(
        uint32 _originDomain,
        uint224 _nonce,
        uint256 _amount
    ) public pure returns (bytes memory) {
        return abi.encode(_originDomain, _nonce, _amount);
    }
}
