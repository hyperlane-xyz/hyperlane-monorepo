// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IAVSDirectory} from "../interfaces/avs/IAVSDirectory.sol";
import {ISignatureUtils} from "../interfaces/avs/ISignatureUtils.sol";
import {IDelegationManager} from "../interfaces/avs/IDelegationManager.sol";
import {ISlasher} from "../interfaces/avs/ISlasher.sol";
import {Quorum, IECDSAStakeRegistry} from "../interfaces/avs/IECDSAStakeRegistry.sol";

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract TestAVSDirectory is IAVSDirectory {
    bytes32 public constant OPERATOR_AVS_REGISTRATION_TYPEHASH =
        keccak256(
            "OperatorAVSRegistration(address operator,address avs,bytes32 salt,uint256 expiry)"
        );
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,uint256 chainId,address verifyingContract)"
        );

    mapping(address => mapping(address => OperatorAVSRegistrationStatus))
        public avsOperatorStatus;

    function updateAVSMetadataURI(string calldata metadataURI) external {
        emit AVSMetadataURIUpdated(msg.sender, metadataURI);
    }

    function registerOperatorToAVS(
        address operator,
        ISignatureUtils.SignatureWithSaltAndExpiry memory operatorSignature
    ) external {
        bytes32 operatorRegistrationDigestHash = calculateOperatorAVSRegistrationDigestHash({
                operator: operator,
                avs: msg.sender,
                salt: operatorSignature.salt,
                expiry: operatorSignature.expiry
            });
        require(
            ECDSA.recover(
                operatorRegistrationDigestHash,
                operatorSignature.signature
            ) == operator,
            "EIP1271SignatureUtils.checkSignature_EIP1271: signature not from signer"
        );
        avsOperatorStatus[msg.sender][operator] = OperatorAVSRegistrationStatus
            .REGISTERED;
    }

    function deregisterOperatorFromAVS(address operator) external {
        avsOperatorStatus[msg.sender][operator] = OperatorAVSRegistrationStatus
            .UNREGISTERED;
    }

    function calculateOperatorAVSRegistrationDigestHash(
        address operator,
        address avs,
        bytes32 salt,
        uint256 expiry
    ) public view returns (bytes32) {
        // calculate the struct hash
        bytes32 structHash = keccak256(
            abi.encode(
                OPERATOR_AVS_REGISTRATION_TYPEHASH,
                operator,
                avs,
                salt,
                expiry
            )
        );
        // calculate the digest hash
        bytes32 digestHash = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), structHash)
        );
        return digestHash;
    }

    function domainSeparator() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN_TYPEHASH,
                    keccak256(bytes("EigenLayer")),
                    block.chainid,
                    address(this)
                )
            );
    }
}

contract TestDelegationManager is IDelegationManager {
    mapping(address => bool) public isOperator;

    function registerAsOperator(
        OperatorDetails calldata registeringOperatorDetails,
        string calldata metadataURI
    ) external {}

    function setIsOperator(
        address operator,
        bool _isOperatorReturnValue
    ) external {
        isOperator[operator] = _isOperatorReturnValue;
    }
}

contract TestSlasher is ISlasher {
    function freezeOperator(address toBeFrozen) external {}
}

import {IServiceManager} from "../interfaces/avs/IServiceManager.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract TestECDSAStakeRegistry is IECDSAStakeRegistry {
    Quorum internal _quorum;
    address internal _serviceManager;

    function initialize(
        address serviceManager,
        uint256,
        Quorum memory
    ) external {
        _serviceManager = serviceManager;
    }

    function quorum() external view returns (Quorum memory) {}

    function registerOperatorWithSignature(
        address _operator,
        ISignatureUtils.SignatureWithSaltAndExpiry memory _operatorSignature
    ) external {
        IServiceManager(_serviceManager).registerOperatorToAVS(
            _operator,
            _operatorSignature
        );
    }

    function deregisterOperator() external {
        IServiceManager(_serviceManager).deregisterOperatorFromAVS(msg.sender);
    }
}
