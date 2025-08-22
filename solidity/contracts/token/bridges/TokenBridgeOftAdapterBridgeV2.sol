// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ValueTransferBridge, Quote} from "../interfaces/ValueTransferBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// LayerZero V2 interfaces
interface IOFTV2 {
    struct SendParam {
        uint32 dstEid;
        bytes32 to;
        uint256 amountLD;
        uint256 minAmountLD;
        bytes extraOptions;
        bytes composeMsg;
        bytes oftCmd;
    }

    struct MessagingFee {
        uint256 nativeFee;
        uint256 lzTokenFee;
    }

    struct MessagingReceipt {
        bytes32 guid;
        uint64 nonce;
        MessagingFee fee;
    }

    function quoteSend(
        SendParam calldata sendParam,
        bool payInLzToken
    ) external view returns (MessagingFee memory);

    function send(
        SendParam calldata sendParam,
        MessagingFee calldata fee,
        address refundAddress
    ) external payable returns (MessagingReceipt memory);
}

// LayerZero V1 interfaces
interface IOFTV1 {
    function sendFrom(
        address from,
        uint16 dstChainId,
        bytes calldata toAddress,
        uint256 amount,
        bytes calldata adapterParams
    ) external payable;

    function estimateSendFee(
        uint16 dstChainId,
        bytes calldata toAddress,
        uint256 amount,
        bool useZro,
        bytes calldata adapterParams
    ) external view returns (uint256 nativeFee, uint256 zroFee);
}

/**
 * @title TokenBridgeOftAdapterBridgeV2
 * @notice ValueTransferBridge adapter for LayerZero OFT bridging with V2/V1 support.
 * @dev Pulls tokens first to avoid approval issues, supports both LZ V2 and V1.
 */
contract TokenBridgeOftAdapterBridgeV2 is ValueTransferBridge, Ownable {
    using SafeERC20 for IERC20;

    struct DomainConfig {
        uint32 hyperlaneDomain;
        uint32 lzEidV2;      // V2 endpoint ID (32-bit)
        uint16 lzEidV1;      // V1 chain ID (16-bit)
        bytes32 dstVault;    // Destination router (32 bytes for V2)
        bytes adapterParams; // V1 adapter params or V2 extra options
    }

    // Hyperlane domain -> LayerZero config
    mapping(uint32 => DomainConfig) public domainConfigs;

    // The OFT token to bridge
    address public immutable oftToken;

    // Whether this OFT uses V2 (detected on first use)
    bool public isV2;
    bool public versionDetected;

    constructor(address _oftToken, address _owner) {
        require(_oftToken != address(0), "Invalid OFT token");
        oftToken = _oftToken;
        _transferOwnership(_owner);
    }

    function addDomain(
        uint32 _hyperlaneDomain,
        uint32 _lzEidV2,
        uint16 _lzEidV1,
        bytes32 _dstVault,
        bytes calldata _adapterParams
    ) external onlyOwner {
        domainConfigs[_hyperlaneDomain] = DomainConfig({
            hyperlaneDomain: _hyperlaneDomain,
            lzEidV2: _lzEidV2,
            lzEidV1: _lzEidV1,
            dstVault: _dstVault,
            adapterParams: _adapterParams
        });
    }

    function quoteTransferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external view override returns (Quote[] memory quotes) {
        DomainConfig memory config = domainConfigs[destinationDomain];
        require(config.hyperlaneDomain == destinationDomain, "Domain not configured");

        quotes = new Quote[](2);
        
        // Try to estimate fee (best effort, actual detection happens during send)
        uint256 nativeFee = 0;
        
        if (!versionDetected || isV2) {
            // Try V2 quote
            try IOFTV2(oftToken).quoteSend(
                IOFTV2.SendParam({
                    dstEid: config.lzEidV2,
                    to: config.dstVault,
                    amountLD: amountOut,
                    minAmountLD: amountOut,
                    extraOptions: config.adapterParams,
                    composeMsg: "",
                    oftCmd: ""
                }),
                false
            ) returns (IOFTV2.MessagingFee memory fee) {
                nativeFee = fee.nativeFee;
            } catch {
                // V2 failed, try V1
                try IOFTV1(oftToken).estimateSendFee(
                    config.lzEidV1,
                    abi.encodePacked(config.dstVault),
                    amountOut,
                    false,
                    config.adapterParams
                ) returns (uint256 v1Fee, uint256) {
                    nativeFee = v1Fee;
                } catch {
                    // Can't estimate, return 0
                }
            }
        } else {
            // Known V1
            try IOFTV1(oftToken).estimateSendFee(
                config.lzEidV1,
                abi.encodePacked(config.dstVault),
                amountOut,
                false,
                config.adapterParams
            ) returns (uint256 v1Fee, uint256) {
                nativeFee = v1Fee;
            } catch {
                // Can't estimate, return 0
            }
        }

        quotes[0] = Quote({token: address(0), amount: nativeFee});
        quotes[1] = Quote({token: oftToken, amount: amountOut});
    }

    function transferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external payable override returns (bytes32) {
        DomainConfig memory config = domainConfigs[destinationDomain];
        require(config.hyperlaneDomain == destinationDomain, "Domain not configured");
        require(recipient != bytes32(0), "Invalid recipient");

        // Pull tokens from the router to this adapter
        IERC20(oftToken).safeTransferFrom(msg.sender, address(this), amountOut);

        // Try V2 first if version not detected or known to be V2
        if (!versionDetected || isV2) {
            bytes memory result = _tryV2Send(config, amountOut);
            if (result.length > 0) {
                if (!versionDetected) {
                    versionDetected = true;
                    isV2 = true;
                }
                return bytes32(result);
            }
            
            // V2 failed, try V1
            if (!versionDetected) {
                bytes32 v1Result = _tryV1Send(config, amountOut);
                versionDetected = true;
                isV2 = false;
                return v1Result;
            }
        } else {
            // Known V1
            return _tryV1Send(config, amountOut);
        }

        revert("OFT send failed");
    }

    function _tryV2Send(
        DomainConfig memory config,
        uint256 amountOut
    ) internal returns (bytes memory) {
        try IOFTV2(oftToken).send{value: msg.value}(
            IOFTV2.SendParam({
                dstEid: config.lzEidV2,
                to: config.dstVault,
                amountLD: amountOut,
                minAmountLD: amountOut,
                extraOptions: config.adapterParams,
                composeMsg: "",
                oftCmd: ""
            }),
            IOFTV2.MessagingFee({
                nativeFee: msg.value,
                lzTokenFee: 0
            }),
            payable(msg.sender) // refund address
        ) returns (IOFTV2.MessagingReceipt memory receipt) {
            return abi.encodePacked(receipt.guid);
        } catch {
            return "";
        }
    }

    function _tryV1Send(
        DomainConfig memory config,
        uint256 amountOut
    ) internal returns (bytes32) {
        IOFTV1(oftToken).sendFrom{value: msg.value}(
            address(this), // Send from adapter's balance
            config.lzEidV1,
            abi.encodePacked(config.dstVault),
            amountOut,
            config.adapterParams
        );
        
        return keccak256(
            abi.encodePacked(
                msg.sender,
                config.hyperlaneDomain,
                config.dstVault,
                amountOut,
                block.number
            )
        );
    }
}