// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./inc/chunks/GlobalPosition.sol";
import "./inc/config/Config.sol";
import "hardhat/console.sol";
import {DataSentTokenContract} from "./DataSentTokenContract.sol";

contract PrivacyFirstContract {

    using GlobalPositionLibrary for GlobalPosition;
    using PackedPositionLibrary for PackedPosition;

    // ---------------------------
    // private state variables
    // ---------------------------
    DataSentTokenContract private immutable _dstContract;
    address payable private _owner;
    string private _ownerPubKey;
    Config private _config;
    bytes private _initiatorPublicKey;
    mapping(address => bool) private _senders;
    mapping(address => bool) private _verifiers;
    //DST INFO
    bool private _initialSupplySettled;
    uint private _remainingSupply;
    uint private _allocatedSupply;
    uint private _senderSupplyBond;
    uint private _verifierSupplyBond;
    //Chunking
    PackedPosition private _smartContractOrigin;

    // ---------------------------
    // Events
    // ---------------------------
    event SenderEnrolledEvent(address indexed sender, string key);
    event SenderEncryptionKeyReady(address sender, string encryptionKey);
    event VerifierEnrolledEvent(address indexed verifier, string key);
    event VerifierDecryptionKeyReady(address sender, string decryptionKey);
    event DataVerificationRequestedEvent(address indexed requester);
    event VerifierElected(address indexed verifier, bytes encryptedCid);

    // ---------------------------
    // Constructor
    // ---------------------------
    constructor(string memory ownerPubKey, Config memory config, address dstContractAddress) {
        require(config.rewardConfig.dataSenderPayout > config.rewardConfig.dataSenderBond,
            "The senders payout isn't greater than senders bond");
        require(config.rewardConfig.dataVerifierPayout > config.rewardConfig.dataVerifierBond,
            "The verifiers payout isn't greater than verifiers bond");
        require(config.originCoordinates.isValid(), "Origin coordinates should be valid");
        _owner = payable(msg.sender);
        _ownerPubKey = ownerPubKey;
        _config = config;

        // Payments
        _dstContract = DataSentTokenContract(dstContractAddress);
        _initialSupplySettled = false;
        _remainingSupply = 0;
        _senderSupplyBond = 0;
        _verifierSupplyBond = 0;
        _allocatedSupply = 0;
        _smartContractOrigin = config.originCoordinates.packCoordinates();
    }

    // ---------------------------
    // Public / external functions
    // ---------------------------

    function getInitiatorPublicKey() public view virtual returns (string memory) {
        return _ownerPubKey;
    }

    function publishEncryptedSenderPublicKey(string calldata encryptedPubKey) public virtual {
        address sender = msg.sender;
        emit SenderEnrolledEvent(sender, encryptedPubKey);
    }

    function publishSenderEncryptionKey(address sender, string calldata encryptionKey) public virtual {
        require(msg.sender == _owner, "Not the owner");
        _senders[sender] = true;
        emit SenderEncryptionKeyReady(sender, encryptionKey);
    }

    function publishEncryptedVerifierPublicKey(string calldata encryptedPubKey) public virtual {
        address verifier = msg.sender;
        emit VerifierEnrolledEvent(verifier, encryptedPubKey);
    }

    function publishVerifierEncryptionKey(address verifier, string calldata decryptionKey) public virtual {
        require(msg.sender == _owner, "Not the owner");
        _verifiers[verifier] = true;
        emit VerifierDecryptionKeyReady(verifier, decryptionKey);
    }

    function getVerifiersKeys() public view virtual returns (bytes[] memory) {
        // TODO: IMPLEMENT
    }

    function publishIpfsDecryptionKey(address sender) public virtual {
        // TODO: IMPLEMENT
    }

    function getIpfsDecryptionKey(address sender) public view virtual returns (bytes memory) {
        // TODO: IMPLEMENT
    }

    function publishIpfsCid(bytes memory cid) public virtual {
        require(_senders[msg.sender] == true, "Only senders allowed");
        //TODO CONTINUE HERE
    }

    function requestAuthToVerify() public virtual {
        // TODO: IMPLEMENT
    }

    function submitVerifyResult(bytes memory encryptedCid, bool result) public virtual {
        // TODO: IMPLEMENT
    }

    // ------------------------------------------------
    // Public / external functions - REFERS TO PAYMENTS
    // ------------------------------------------------

    function payInitialSupply() external {
        require(_owner == msg.sender, "Initial supply can be settled only by owner");
        _dstContract.transferFrom(msg.sender, address(this), _config.rewardConfig.totalDst);
        _remainingSupply = _config.rewardConfig.totalDst;
        _initialSupplySettled = true;
    }

    // ---------------------------
    // Private methods here
    // ---------------------------

    // ------------------------------------
    // Private methods - REFERS TO PAYMENTS
    // ------------------------------------

    function userPayContract(bool isSender) internal {
        require(_owner != msg.sender, "Owner can settle only the initial supply");
        if (isSender == true) {
            require(_senders[msg.sender] == true, "Not a sender");
            _dstContract.transferFrom(msg.sender, address(this), _config.rewardConfig.dataSenderBond);
            _senderSupplyBond = _senderSupplyBond + _config.rewardConfig.dataSenderBond;
        } else {
            require(_verifiers[msg.sender] == true, "Not a verifier");
            _dstContract.transferFrom(msg.sender, address(this), _config.rewardConfig.dataVerifierBond);
            _verifierSupplyBond = _verifierSupplyBond + _config.rewardConfig.dataVerifierBond;
        }

        //TODO SALVARE I SENDER/VERIFIERS AL DATO CHE HANNO INVIATO O STANNO VERIFICANDO
    }

    function _userPayContract(bool isSender) internal {
        require(msg.sender != _owner, "Owner can settle only the initial supply");

        if (isSender) {
            _paySender();
        } else {
            _payVerifier();
        }
    }

    function _paySender() internal {
        require(_senders[msg.sender], "Not a sender");
        _dstContract.transferFrom(msg.sender, address(this), _config.rewardConfig.dataSenderBond);
        _senderSupplyBond = _senderSupplyBond + _config.rewardConfig.dataSenderBond;

        // TODO: associa msg.sender al dato inviato
    }

    function _payVerifier() internal {
        require(_verifiers[msg.sender], "Not a verifier");

        _dstContract.transferFrom(msg.sender, address(this), _config.rewardConfig.dataVerifierBond);
        _verifierSupplyBond = _verifierSupplyBond + _config.rewardConfig.dataVerifierBond;

        // TODO: associa msg.sender al dato verificato
    }

    function _computeDstPerDatum(Config calldata config) pure internal returns (uint256)  {
        return config.rewardConfig.dataSenderPayout + (config.needs.checksRequired * config.rewardConfig.dataVerifierPayout);
    }


}
