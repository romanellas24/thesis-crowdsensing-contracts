// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./PrivacyFirstContract.sol";

using GlobalPositionLibrary for GlobalPosition;
using PackedPositionLibrary for PackedPosition;

contract PrivacySecondContract is PrivacyFirstContract {

    mapping(uint256 => bool) private _awaitingKeyGeneration;
    mapping(uint256 => mapping(uint8 => bool)) private _bundleDelivered;

    event DataRequiredVerificationKeyGeneration(uint256 indexed dataId);
    event VerifierElectedForData(address indexed verifier, uint256 indexed dataId);
    event VerifierVerificationBundleReady(address indexed verifier, uint256 indexed dataId, bytes bundle);
    event VerifierEnrolled(address indexed verifier);

    constructor(string memory ownerPubKey, Config memory config, address dstContractAddress) PrivacyFirstContract(ownerPubKey, config, dstContractAddress) {}


    // Overrides
    function publishVerifierDecryptionKey(address verifier, string calldata) public override {
        require(_campaignOpen, "Campaign is closed");
        require(msg.sender == _owner, "Not the owner");
        _verifiers[verifier] = true;
        _verifierInformation[verifier] = VerifierInformation({
            lastVerified: 0,
            hasVerified: false,
            verifyingData: 0,
            isVerifying: false,
            bondBalance: 0
        });
        delete _verifierEnrolledRequest[verifier];
        emit VerifierEnrolled(verifier);
    }

    function publishIpfsCid(
        bytes calldata encryptedCid,
        GlobalPosition calldata position
    ) external override {
        require(_campaignOpen, "Campaign is closed");
        require(_senders[msg.sender], "Only senders allowed to send data.");
        require(position.isValid(), "Invalid Coordinates");
        require(_senderInformation[msg.sender].dataSubmitted < _config.needs.maxDataPerSender || _config.needs.maxDataPerSender == 0, "Max data limit reached");
        require(_senderInformation[msg.sender].bondBalance >= _config.rewardConfig.dataSenderBondPerData || _config.needs.maxDataPerSender == 0, "Insufficient DST balance in bond, please refund");

        PackedPosition memory packed = position.packCoordinates();
        (uint16 chunkIndex, bool inside) = _getChunkIndex(packed);
        require(inside, "Outside campaign area");
        require(_dataPerChunkReceived[chunkIndex] < _config.needs.maximumDataPerChunk || _config.needs.maximumDataPerChunk == 0, "Too many data in this chunk!");

        _dataEntries[_dataCount] = DataEntry({
            sender: msg.sender,
            status: DataStatus.PENDING,
            completedChecks: 0,
            positiveChecks: 0,
            assignedChecks: 0,
            chunkIndex: chunkIndex,
            earliestSlotDeadline: 0,
            encryptedCid: encryptedCid
        });
        _dataPerChunkReceived[chunkIndex]++;
        _senderInformation[msg.sender].dataSubmitted++;

        _awaitingKeyGeneration[_dataCount] = true;
        emit DataRequiredVerificationKeyGeneration(_dataCount);

        _dataCount++;

        if (_config.needs.maxDataPerSender > 0) {
            unchecked {
                _senderInformation[msg.sender].bondBalance = _senderInformation[msg.sender].bondBalance - _config.rewardConfig.dataSenderBondPerData;
            }
        }
    }

    // Now the datum enters the pending queue for verification.
    function notifyVerificationKeyReady(uint256 dataId) external {
        require(msg.sender == _owner, "Not the owner");
        require(_campaignOpen, "Campaign is closed");
        require(_awaitingKeyGeneration[dataId], "Data not awaiting key generation");
        delete _awaitingKeyGeneration[dataId];
        _addToPending(dataId);
        emit DataVerificationRequestedEvent(dataId);
    }

    function _emitVerifierElected(address verifier, uint256 dataId, uint8 slotIndex)
    internal override
    {
        delete _bundleDelivered[dataId][slotIndex];
        emit VerifierElectedForData(verifier, dataId);
    }

    function deliverVerificationBundle(
        uint256 dataId,
        address verifier,
        bytes calldata bundle
    ) external {
        require(msg.sender == _owner, "Not the owner");
        require(_campaignOpen, "Campaign is closed");
        require(_verifierInformation[verifier].isVerifying, "Verifier not active");
        require(_verifierInformation[verifier].verifyingData == dataId, "Verifier not assigned to this data");

        (uint8 slotIndex, bool found) = _getVerifierSlotIndex(dataId, verifier);
        require(found, "Slot not found");
        require(!_bundleDelivered[dataId][slotIndex], "Bundle already delivered");
        _bundleDelivered[dataId][slotIndex] = true;

        emit VerifierVerificationBundleReady(verifier, dataId, bundle);
    }

    function submitVerifyResult(VerificationResult result) public virtual override {
        if (result != VerificationResult.CANNOT_COMPLETE) {
            uint256 dataId = getActiveVerification();
            (uint8 slotIndex, bool found) = _getVerifierSlotIndex(dataId, msg.sender);
            if (found && _verificationSlots[dataId][slotIndex].deadline >= block.timestamp) {
                require(_bundleDelivered[dataId][slotIndex], "Bundle not delivered yet");
            }
        }
        super.submitVerifyResult(result);
    }

}