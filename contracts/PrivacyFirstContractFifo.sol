// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "./PrivacyFirstContract.sol";
import "./inc/config/Config.sol";

/**
 * @title PrivacyFirstContractFifo
 * @dev FIFO-preserving variant of PrivacyFirstContract.
 *
 * The only behavioral difference w.r.t. PrivacyFirstContract is the
 * management of the pending data list:
 *   - _addToPending appends to the tail (no auxiliary index map).
 *   - _removeFromPending performs a linear search followed by a
 *     left-shift of every subsequent element, preserving insertion
 *     order at the cost of O(n) writes per removal.
 *
 * This contract is intended exclusively as a baseline for the gas
 * cost analysis comparison against the swap-and-pop optimization
 * applied in the base contract. The inherited `_pendingIndex` mapping
 * is left unused: its storage slot is reserved but never written.
 *
 * All other protocol logic is inherited verbatim.
 */
contract PrivacyFirstContractFifo is PrivacyFirstContract {

    constructor(
        string memory ownerPubKey,
        Config memory config,
        address dstContractAddress
    ) PrivacyFirstContract(ownerPubKey, config, dstContractAddress) {}

    function _addToPending(uint256 dataId) internal override {
        _pendingDataIds.push(dataId);
    }

    function _removeFromPending(uint256 dataId) internal override {
        uint256 len = _pendingDataIds.length;
        uint256 idx = len;
        for (uint256 i = 0; i < len; i++) {
            if (_pendingDataIds[i] == dataId) {
                idx = i;
                break;
            }
        }
        require(idx < len, "Data not in pending");
        for (uint256 i = idx; i + 1 < len; i++) {
            _pendingDataIds[i] = _pendingDataIds[i + 1];
        }
        _pendingDataIds.pop();
    }
}