// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../../libs/Message.sol";
import {IWormholeIsm} from "../../interfaces/isms/IWormholeIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IWormhole} from "../../interfaces/IWormhole.sol";

abstract contract AbstractWormholeIsm is IWormholeIsm {
    IWormhole immutable wormhole;
    mapping(uint16 => uint32) public wormholeChainIdToHyperlaneDomainId;
    mapping(uint32 => bytes32) public domainIdToEmitter;

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.WORMHOLE);

    constructor(
        address _wormhole,
        uint16[] memory _chainIds,
        uint32[] memory _domainIds,
        bytes32[] memory _emitters
    ) {
        wormhole = IWormhole(_wormhole);
        require(_chainIds.length == _domainIds.length);
        require(_domainIds.length == _emitters.length);
        for (uint256 i = 0; i < _chainIds.length; ++i) {
            wormholeChainIdToHyperlaneDomainId[_chainIds[i]] = _domainIds[i];
            domainIdToEmitter[_domainIds[i]] = _emitters[i];
        }
    }

    function emitter(bytes calldata _message)
        internal
        view
        virtual
        returns (bytes32);

    function emitterAndPayload(bytes calldata _message)
        public
        view
        virtual
        override
        returns (bytes32, bytes32)
    {
        bytes32 _emitter = emitter(_message);
        bytes32 _id = Message.id(_message);
        bytes32 _payload = keccak256(abi.encodePacked(_emitter, _id));

        uint32 _origin = Message.origin(_message);

        return (domainIdToEmitter[_origin], _payload);
    }

    function verify(bytes calldata _metadata, bytes calldata _message)
        public
        view
        returns (bool)
    {
        // First, require that the wormhole message was verified by the guardians
        (IWormhole.VM memory vm, bool valid, ) = wormhole.parseAndVerifyVM(
            _metadata
        );

        // Next, ensure that the wormhole message was sent by the expected
        // hook contract on the expected origin chain.
        require(
            wormholeChainIdToHyperlaneDomainId[vm.emitterChainId] ==
                Message.origin(_message)
        );
        (bytes32 expectedEmitter, bytes32 expectedPayload) = emitterAndPayload(
            _message
        );
        require(vm.emitterAddress == expectedEmitter);

        // Next, require that the wormhole message contains the expected contents.
        bytes32 actualPayload = bytes32(vm.payload);
        require(actualPayload == expectedPayload);

        return valid;
    }
}
