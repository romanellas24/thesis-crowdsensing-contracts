// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./inc/chunks/GlobalPosition.sol";
import "./inc/config/Config.sol";
import "./inc/data/DataEntry.sol";
import "./inc/data/VerificationSlot.sol";
import "./inc/senders/SenderInformation.sol";
import "./inc/verifiers/VerificationResult.sol";
import "./inc/verifiers/VerifierInformation.sol";
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
    //users that have enrolled (waiting for B's encryption key publishing)
    mapping(address => bool) private _senderEnrolledRequest;
    mapping(address => bool) private _verifierEnrolledRequest;
    //Effective enrolled users
    mapping(address => bool) private _senders;
    mapping(address => bool) private _verifiers;
    //data containing
    mapping(uint256 => DataEntry) private _dataEntries;
    uint256 private _dataCount;
    //Verifier containing
    mapping(uint256 => mapping(uint8 => VerificationSlot)) private _verificationSlots;
    mapping(address => SenderInformation) private _senderInformation;
    mapping(address => VerifierInformation) private _verifierInformation;

    //Campaign lifecycle
    bool private _campaignOpen;
    uint256 private _validDataCount;
    uint256 private _uniqueValidSenders;
    mapping(address => bool) private _senderHasValidData;

    //DST INFO
    bool private _initialSupplySettled;
    uint private _remainingSupply;
    uint private _senderSupplyBond;
    uint private _verifierSupplyBond;
    // DST INFO / BONDS TO SUPPLY FOR WORK
    uint private _requiredSenderBond;
    uint private _requiredVerifierBond;
    //Chunking
    PackedPosition private _smartContractOrigin;
    PackedPosition private _smartContractEnd;
    mapping(uint16 => uint) private _dataPerChunkReceived;

    // ---------------------------
    // Events
    // ---------------------------
    event SenderEnrolledEvent(address indexed sender, string key);
    event SenderEncryptionKeyReady(address sender, string encryptionKey);
    event VerifierEnrolledEvent(address indexed verifier, string key);
    event VerifierDecryptionKeyReady(address sender, string decryptionKey);
    event DataVerificationRequestedEvent(uint256); //The emitted value is the index of data that is ready for verification (because it is already uploaded).
    event VerifierElected(address indexed verifier, uint256 indexed dataId, uint8 slotIndex, bytes encryptedCid);
    event DataVerified(uint256 indexed dataId, bool result);
    event CampaignClosed();

    // ---------------------------
    // Constructor
    // ---------------------------
    constructor(string memory ownerPubKey, Config memory config, address dstContractAddress) {
        require(config.rewardConfig.dataSenderPayout > config.rewardConfig.dataSenderBondPerData,
            "The senders payout isn't greater than senders bond");
        require(config.rewardConfig.dataVerifierPayout > config.rewardConfig.dataVerifierBondPerData,
            "The verifiers payout isn't greater than verifiers bond");
        require(config.originCoordinates.isValid(), "Origin coordinates should be valid");
        require(config.needs.checksRequired % 2 == 1, "Checks must be odd");
        require(config.chunkConfig.chunk4Side > 0, "chunk4Side must be greater than 0");
        require(config.chunkConfig.chunkSize > 0, "chunkSize must be greater than 0");

        _owner = payable(msg.sender);
        _ownerPubKey = ownerPubKey;
        _config = config;

        // Payments
        _dstContract = DataSentTokenContract(dstContractAddress);
        _initialSupplySettled = false;
        _remainingSupply = 0;
        _senderSupplyBond = 0;
        _verifierSupplyBond = 0;

        //Campaign Coordinates
        _smartContractOrigin = config.originCoordinates.packCoordinates();
        int32 totalArea = int32(uint32(config.chunkConfig.chunkSize * config.chunkConfig.chunk4Side));
        _smartContractEnd = PackedPosition({
            latE7: _smartContractOrigin.latE7 + totalArea,
            lonE7: _smartContractOrigin.lonE7 + totalArea
        });

        //Campaign Opening
        _campaignOpen = true;
        //Data
        _validDataCount = 0;
        _uniqueValidSenders = 0;

        _requiredSenderBond = _config.needs.maxDataPerSender * _config.rewardConfig.dataSenderBondPerData;
        _requiredVerifierBond = _config.needs.maxDataPerVerifierPerBond * _config.rewardConfig.dataVerifierBondPerData;
    }

    // ---------------------------
    // Public / external functions
    // ---------------------------

    function getInitiatorPublicKey() public view virtual returns (string memory) {
        return _ownerPubKey;
    }

    function publishEncryptedSenderPublicKey(string calldata encryptedPubKey) public virtual {
        require(_campaignOpen, "Campaign is closed");
        require(!_senderEnrolledRequest[msg.sender], "Sender has already requested to join");
        _senderEnrolledRequest[msg.sender] = true;
        emit SenderEnrolledEvent(msg.sender, encryptedPubKey);
    }

    function publishSenderEncryptionKey(address sender, string calldata encryptionKey) public virtual {
        require(_campaignOpen, "Campaign is closed");
        require(msg.sender == _owner, "Not the owner");
        _senders[sender] = true;
        _senderInformation[sender] = SenderInformation({
            bondBalance: 0,
            dataSubmitted: 0,
            validData: 0,
            invalidData: 0
        });
        emit SenderEncryptionKeyReady(sender, encryptionKey);
    }

    function publishEncryptedVerifierPublicKey(string calldata encryptedPubKey) public virtual {
        require(_campaignOpen, "Campaign is closed");
        require(!_verifierEnrolledRequest[msg.sender], "Verifier has already requested to join");
        _verifierEnrolledRequest[msg.sender] = true;
        emit VerifierEnrolledEvent(msg.sender, encryptedPubKey);
    }

    function publishVerifierDecryptionKey(address verifier, string calldata decryptionKey) public virtual {
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
        emit VerifierDecryptionKeyReady(verifier, decryptionKey);
    }

    function publishIpfsCid(bytes memory encryptedCid, GlobalPosition calldata position) external virtual {
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
            encryptedCid: encryptedCid,
            status: DataStatus.PENDING,
            completedChecks: 0,
            positiveChecks: 0,
            assignedChecks: 0,
            chunkIndex: chunkIndex
        });
        _dataPerChunkReceived[chunkIndex]++;
        _senderInformation[msg.sender].dataSubmitted++;
        emit DataVerificationRequestedEvent(_dataCount);
        _dataCount++;

        if (_config.needs.maxDataPerSender > 0) {
            _senderInformation[msg.sender].bondBalance = _senderInformation[msg.sender].bondBalance - _config.rewardConfig.dataSenderBondPerData;
        }

    }

    function requestAuthToVerify() external virtual {
        require(_campaignOpen, "Campaign is closed");
        require(_verifiers[msg.sender], "Only verifiers allowed");
        require(!_verifierInformation[msg.sender].isVerifying, "Already verifying data");
        require(_verifierInformation[msg.sender].bondBalance >= _config.rewardConfig.dataVerifierBondPerData, "Insufficient DST balance in bond, please refund");

        uint256 start = 0;
        if (_verifierInformation[msg.sender].hasVerified) {
            start = _verifierInformation[msg.sender].lastVerified + _config.needs.verifierCooldown;
        }

        for (uint256 dataIndex = start; dataIndex < _dataCount; dataIndex++) {
            if (_dataEntries[dataIndex].status != DataStatus.PENDING) continue;

            (uint8 slotIndex, bool found) = _findAvailableSlot(dataIndex);
            if (!found) continue;

            _verifierInformation[msg.sender].bondBalance = _verifierInformation[msg.sender].bondBalance - _config.rewardConfig.dataVerifierBondPerData;

            _verificationSlots[dataIndex][slotIndex] = VerificationSlot({
                verifier: msg.sender,
                result: false,
                completed: false,
                deadline: block.timestamp + _config.needs.verificationTimeout
            });

            if (slotIndex >= _dataEntries[dataIndex].assignedChecks) {
                _dataEntries[dataIndex].assignedChecks = slotIndex + 1;
            }

            _verifierInformation[msg.sender].verifyingData = dataIndex;
            _verifierInformation[msg.sender].isVerifying = true;

            emit VerifierElected(msg.sender, dataIndex, slotIndex, _dataEntries[dataIndex].encryptedCid);
            return;
        }

        revert("No data available for verification");
    }

    //This function returns the active verification for Verifier.
    function getActiveVerification() public view returns (uint256) {
        require(_verifiers[msg.sender], "Only verifiers allowed");
        require(_verifierInformation[msg.sender].isVerifying, "No active verification");
        return _verifierInformation[msg.sender].verifyingData;
    }

    function submitVerifyResult(VerificationResult result) external virtual {
        require(_verifiers[msg.sender], "Only verifiers allowed");
        uint256 dataId = getActiveVerification();
        (uint8 slotIndex, bool slotForVerifierFound) = _getVerifierSlotIndex(dataId, msg.sender);
        require(slotForVerifierFound, "Invalid slot");
        require(!_verificationSlots[dataId][slotIndex].completed, "Already completed");

        if (result == VerificationResult.CANNOT_COMPLETE) {
            _removeVerifierFromData(dataId, slotIndex);
            _makeVerifierAbleToOperate(msg.sender);
            _verifierInformation[msg.sender].bondBalance = _verifierInformation[msg.sender].bondBalance + _config.rewardConfig.dataVerifierBondPerData;
            return;
        }
        //Here the verifier has a valid value for validation

        if (_verificationSlots[dataId][slotIndex].deadline < block.timestamp) { //expired
            _makeVerifierAbleToOperate(msg.sender);
            _removeVerifierFromData(dataId, slotIndex);
            _verifierInformation[msg.sender].bondBalance = _verifierInformation[msg.sender].bondBalance + _config.rewardConfig.dataVerifierBondPerData;
            return;
        }

        //we can register the response
        _registerVerifierResponse(dataId, slotIndex, (result == VerificationResult.SUCCESS));
        if (_dataEntries[dataId].status == DataStatus.PENDING) {
            //if pending but we can determinate a response, we can also calculate the majority.
            _determinateVerifiersDecision(dataId);
        }
        _tryRewardVerifier(dataId, slotIndex);
    }

    function payInitialSupply() external {
        require(_campaignOpen, "Campaign is closed");
        require(_owner == msg.sender, "Initial supply can be settled only by owner");
        _dstContract.transferFrom(msg.sender, address(this), _config.rewardConfig.totalDst);
        _remainingSupply = _config.rewardConfig.totalDst;
        _initialSupplySettled = true;
    }

    function senderPayBond() external {
        require(_senders[msg.sender], "Not a sender");
        _dstContract.transferFrom(msg.sender, address(this), _requiredSenderBond);
        _senderSupplyBond = _senderSupplyBond + _requiredSenderBond;
        _senderInformation[msg.sender].bondBalance = _senderInformation[msg.sender].bondBalance + _requiredSenderBond;
    }

    function getRequiredSenderBond() external view returns (uint) {
        return _requiredSenderBond;
    }

    function getRequiredVerifierBond() external view returns (uint) {
        return _requiredVerifierBond;
    }

    function getDstScAddress() external view returns (address) {
        return address(_dstContract);
    }

    function verifierPayBond() external {
        require(_verifiers[msg.sender], "Not a verifier");
        _dstContract.transferFrom(msg.sender, address(this), _requiredVerifierBond);
        _verifierSupplyBond = _verifierSupplyBond + _requiredVerifierBond;
        _verifierInformation[msg.sender].bondBalance = _verifierInformation[msg.sender].bondBalance + _requiredVerifierBond;
    }

    function withdrawBond() external {
        require(_senders[msg.sender] || _verifiers[msg.sender], "Not a sender neither verifier");
        require((_senderInformation[msg.sender].bondBalance + _verifierInformation[msg.sender].bondBalance) > 0, "Nothing to withdraw");
        uint256 amount = 0;
        if (_senders[msg.sender]) {
            amount = _senderInformation[msg.sender].bondBalance;
            _senderSupplyBond = _senderSupplyBond - _senderInformation[msg.sender].bondBalance;
            _senderInformation[msg.sender].bondBalance = 0;
        }
        if (_verifiers[msg.sender]) {
            amount = amount + _verifierInformation[msg.sender].bondBalance;
            _verifierSupplyBond = _verifierSupplyBond - _verifierInformation[msg.sender].bondBalance;
            _verifierInformation[msg.sender].bondBalance = 0;
        }
        require(amount > 0, "No bond to withdraw");
        _dstContract.transfer(msg.sender, amount);
    }

    // Campaign public methods
    function closeCampaign() external {
        require(msg.sender == _owner, "Only owner");
        require(_campaignOpen, "Campaign already closed");
        _campaignOpen = false;
        emit CampaignClosed();
    }

    // ---------------------------
    // Private methods here
    // ---------------------------

    function _findAvailableSlot(uint256 dataId) internal view returns (uint8, bool) {
        for (uint8 i = 0; i < _dataEntries[dataId].assignedChecks; i++) {
            VerificationSlot storage slot = _verificationSlots[dataId][i];
            //Reassign slot if expired.
            if (!slot.completed && slot.deadline < block.timestamp) {
                return (i, true);
            }
        }
        // Use next fresh slot if exists and there is no expired slot.
        if (_dataEntries[dataId].assignedChecks < _config.needs.checksRequired) {
            return (_dataEntries[dataId].assignedChecks, true);
        }
        //No flot avail, return.
        return (0, false);
    }


    function _getVerifierSlotIndex(uint256 dataId, address verifier) internal view returns (uint8, bool) {
        uint8 assigned = _dataEntries[dataId].assignedChecks;
        for (uint8 i = 0; i < assigned; i++)
            if (_verificationSlots[dataId][i].verifier == verifier)
                return (i, true);
        return (0, false);
    }


    function _makeVerifierAbleToOperate(address verifier) internal {
        _verifierInformation[verifier].verifyingData = 0;
        _verifierInformation[verifier].isVerifying = false;
    }

    function _removeVerifierFromData(uint256 dataId, uint8 slotId) internal {
        _verificationSlots[dataId][slotId].verifier = address(0);
        _verificationSlots[dataId][slotId].deadline = 0;
    }

    function _registerVerifierResponse(uint256 dataId, uint8 slotId, bool response) internal {
        _verificationSlots[dataId][slotId].completed = true;
        _verificationSlots[dataId][slotId].result = response;
        _dataEntries[dataId].completedChecks++;
        if (response) {
            _dataEntries[dataId].positiveChecks = _dataEntries[dataId].positiveChecks + 1;
        }
        _verifierInformation[msg.sender].lastVerified = dataId;
        _verifierInformation[msg.sender].hasVerified = true;
        _verifierInformation[msg.sender].isVerifying = false;
    }

    function _determinateVerifiersDecision(uint256 dataId) internal {
        uint8 majority = (_config.needs.checksRequired / 2) + 1;

        if (_dataEntries[dataId].positiveChecks >= majority) {
            _dataEntries[dataId].status = DataStatus.VALID;
            _senderInformation[_dataEntries[dataId].sender].validData++;
            _validDataCount++;

            if (!_senderHasValidData[_dataEntries[dataId].sender]) {
                _senderHasValidData[_dataEntries[dataId].sender] = true;
                _uniqueValidSenders++;
            }

            _rewardSender(dataId);
            _rewardCorrectVerifiers(dataId, true);
            emit DataVerified(dataId, true);
            _checkCampaignCompletion();
        } else if (_dataEntries[dataId].completedChecks - _dataEntries[dataId].positiveChecks >= majority) {
            _dataEntries[dataId].status = DataStatus.INVALID;
            _senderInformation[_dataEntries[dataId].sender].invalidData++;
            _rewardCorrectVerifiers(dataId, false);
            emit DataVerified(dataId, false);
        }
    }

    function _getChunkIndex(PackedPosition memory packed) internal view returns (uint16, bool) {
        // Check bounds
        if (packed.latE7 < _smartContractOrigin.latE7 || packed.latE7 >= _smartContractEnd.latE7) return (0, false);
        if (packed.lonE7 < _smartContractOrigin.lonE7 || packed.lonE7 >= _smartContractEnd.lonE7) return (0, false);

        // Calculating row and col
        int32 chunkSize = int32(uint32(_config.chunkConfig.chunkSize));
        uint16 row = uint16(uint32((packed.latE7 - _smartContractOrigin.latE7) / chunkSize));
        uint16 col = uint16(uint32((packed.lonE7 - _smartContractOrigin.lonE7) / chunkSize));

        uint16 index = row * _config.chunkConfig.chunk4Side + col;
        return (index, true);
    }

    // ------------------------------------
    // Private methods - REFERS TO PAYMENTS
    // ------------------------------------

    function _rewardSender(uint256 dataId) internal {
        address sender = _dataEntries[dataId].sender;
        uint256 total = _config.rewardConfig.dataSenderPayout + _config.rewardConfig.dataSenderBondPerData;
        require(_remainingSupply >= _config.rewardConfig.dataSenderPayout, "Insufficient supply");
        require(_senderSupplyBond >= _config.rewardConfig.dataSenderBondPerData, "Insufficient bond for senders (should never happen)");
        _remainingSupply = _remainingSupply - _config.rewardConfig.dataSenderPayout;
        _senderSupplyBond = _senderSupplyBond - _config.rewardConfig.dataSenderBondPerData;
        _dstContract.transfer(sender, total);
    }

    //Reward verifiers on majority determination
    function _rewardCorrectVerifiers(uint256 dataId, bool dataWasValid) internal {
        uint8 assigned = _dataEntries[dataId].assignedChecks;
        for (uint8 i = 0; i < assigned; i++) {
            VerificationSlot storage slot = _verificationSlots[dataId][i];
            if (!slot.completed) continue;
            if (slot.result == dataWasValid) {
                uint256 total = _config.rewardConfig.dataVerifierPayout + _config.rewardConfig.dataVerifierBondPerData;
                require(_remainingSupply >= _config.rewardConfig.dataVerifierPayout, "Insufficient supply");
                require(_verifierSupplyBond >= _config.rewardConfig.dataVerifierBondPerData, "Insufficient bond for verifiers (should never happen)");
                _dstContract.transfer(slot.verifier, total);
                _remainingSupply = _remainingSupply - _config.rewardConfig.dataVerifierPayout;
                _verifierSupplyBond = _verifierSupplyBond - _config.rewardConfig.dataVerifierBondPerData;
            }
        }
    }

    //Reward verifiers on next submissions
    function _tryRewardVerifier(uint256 dataId, uint8 slotIndex) internal {
        DataStatus status = _dataEntries[dataId].status;
        if (status == DataStatus.PENDING) return;

        VerificationSlot storage slot = _verificationSlots[dataId][slotIndex];
        bool votedCorrectly = (status == DataStatus.VALID && slot.result)
            || (status == DataStatus.INVALID && !slot.result);

        if (votedCorrectly) {
            uint256 total = _config.rewardConfig.dataVerifierPayout + _config.rewardConfig.dataVerifierBondPerData;
            require(_remainingSupply >= _config.rewardConfig.dataVerifierPayout, "Insufficient supply");
            require(_verifierSupplyBond >= _config.rewardConfig.dataVerifierBondPerData, "Insufficient bond for verifiers (should never happen)");
            _dstContract.transfer(slot.verifier, total);
            _remainingSupply = _remainingSupply - _config.rewardConfig.dataVerifierPayout;
            _verifierSupplyBond = _verifierSupplyBond - _config.rewardConfig.dataVerifierBondPerData;
        }
    }

    //Campaign private methods
    function _checkCampaignCompletion() internal {
        bool dataOk = _config.needs.dataNeeded == 0 || _validDataCount >= _config.needs.dataNeeded;
        bool participantsOk = _config.needs.minimumParticipants == 0 || _uniqueValidSenders >= _config.needs.minimumParticipants;

        if (dataOk && participantsOk && (_config.needs.dataNeeded > 0 || _config.needs.minimumParticipants > 0)) {
            _campaignOpen = false;
            emit CampaignClosed();
        }
    }

    function getCampaignData() external view returns (bytes[] memory cids, DataStatus[] memory statuses, uint16[] memory chunks) {
        require(msg.sender == _owner, "Only owner");
        cids = new bytes[](_dataCount);
        statuses = new DataStatus[](_dataCount);
        chunks = new uint16[](_dataCount);
        for (uint256 i = 0; i < _dataCount; i++) {
            cids[i] = _dataEntries[i].encryptedCid;
            statuses[i] = _dataEntries[i].status;
            chunks[i] = _dataEntries[i].chunkIndex;
        }
    }

}
