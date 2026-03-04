// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./GlobalPackedPosition.sol";

/// @notice Modello dati per coordinate con parte intera e decimale (7 cifre)
struct GlobalPosition {
    int32 latitudeInteger;     // [-90, +90]
    uint32 latitudeDecimal;    // [0 .. 9_999_999]
    int32 longitudeInteger;    // [-180, +180]
    uint32 longitudeDecimal;   // [0 .. 9_999_999]
}

library GlobalPositionLibrary {
    error InvalidLatitudeInteger(int32 value);
    error InvalidLatitudeDecimal(uint32 value);
    error InvalidLongitudeInteger(int32 value);
    error InvalidLongitudeDecimal(uint32 value);

    /// @notice Ritorna true se la posizione rispetta i vincoli richiesti.
    function isValid(GlobalPosition memory p) internal pure returns (bool) {
        if (p.latitudeInteger < -90 || p.latitudeInteger > 90) return false;
        if (p.latitudeDecimal > 9_999_999) return false;

        if (p.longitudeInteger < -180 || p.longitudeInteger > 180) return false;
        if (p.longitudeDecimal > 9_999_999) return false;

        return true;
    }

    /// @notice Versione che fa revert con errori mirati (utile on-chain)
    function requireValid(GlobalPosition memory p) internal pure {
        if (p.latitudeInteger < -90 || p.latitudeInteger > 90) {
            revert InvalidLatitudeInteger(p.latitudeInteger);
        }
        if (p.latitudeDecimal > 9_999_999) {
            revert InvalidLatitudeDecimal(p.latitudeDecimal);
        }
        if (p.longitudeInteger < -180 || p.longitudeInteger > 180) {
            revert InvalidLongitudeInteger(p.longitudeInteger);
        }
        if (p.longitudeDecimal > 9_999_999) {
            revert InvalidLongitudeDecimal(p.longitudeDecimal);
        }
    }

    /// @notice Packs a GlobalPosition (integer + decimal parts) into a single
    ///         int32 per axis in E7 format (1e-7 degree precision, ~1.1cm).
    ///         Example: lat 44 DEG 1234567 => 441234567
    ///         For negative values, the decimal part is subtracted: -9 DEG 5000000 => -95000000
    /// @param p The unpacked position with separate integer and decimal components
    /// @return PackedPosition with latE7 and lonE7 as compact int32 values
    function packCoordinates(GlobalPosition memory p) internal pure returns (PackedPosition memory) {
        int64 latBase = int64(p.latitudeInteger) * 10_000_000;
        int64 lonBase = int64(p.longitudeInteger) * 10_000_000;

        int64 latE7 = p.latitudeInteger < 0
            ? latBase - int64(uint64(p.latitudeDecimal))
            : latBase + int64(uint64(p.latitudeDecimal));

        int64 lonE7 = p.longitudeInteger < 0
            ? lonBase - int64(uint64(p.longitudeDecimal))
            : lonBase + int64(uint64(p.longitudeDecimal));

        return PackedPosition({
            latE7: int32(latE7),
            lonE7: int32(lonE7)
        });
    }

}