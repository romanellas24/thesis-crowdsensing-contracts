// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "./DataEnum.sol";

    struct DataEntry {
        address sender;
        DataStatus status;
        uint8 completedChecks;
        uint8 positiveChecks;
        uint8 assignedChecks;
        uint16 chunkIndex;
        uint48 earliestSlotDeadline;
        bytes encryptedCid;
    }