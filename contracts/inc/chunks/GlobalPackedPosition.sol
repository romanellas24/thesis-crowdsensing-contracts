// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

struct PackedPosition {
    int32 latE7; // es. 45.1234567 DEG -> 451234567
    int32 lonE7; // es.  9.0000000 DEG ->  90000000
}

library PackedPositionLibrary {
    int32 constant LAT_MIN = -900_000_000;
    int32 constant LAT_MAX =  900_000_000;
    int32 constant LON_MIN = -1_800_000_000;
    int32 constant LON_MAX =  1_800_000_000;

    error InvalidLat(int32 latE7);
    error InvalidLon(int32 lonE7);

    /// @notice Ritorna true se p è dentro (bordi inclusi) al rettangolo definito da a e b.
    /// @dev Gestisce automaticamente l’attraversamento dell’antimeridiano.
    function contains(
        PackedPosition calldata a,
        PackedPosition calldata b,
        PackedPosition calldata p
    ) internal pure returns (bool) {
        _requireValid(a);
        _requireValid(b);
        _requireValid(p);

        // --- LAT: intervallo normale ---
        int32 latMin = a.latE7 < b.latE7 ? a.latE7 : b.latE7;
        int32 latMax = a.latE7 > b.latE7 ? a.latE7 : b.latE7;
        if (p.latE7 < latMin || p.latE7 > latMax) return false;

        // --- LON: gestisci eventuale antimeridiano ---
        int32 lonMin = a.lonE7 < b.lonE7 ? a.lonE7 : b.lonE7;
        int32 lonMax = a.lonE7 > b.lonE7 ? a.lonE7 : b.lonE7;

        // Se l'intervallo diretto supera 180°, il rettangolo attraversa l'antimeridiano
        int256 directSpan = int256(lonMax) - int256(lonMin);
        bool crossesAntiMeridian = directSpan > 1_800_000_000;

        if (!crossesAntiMeridian) {
            // caso normale: lonMin <= p.lon <= lonMax
            return (p.lonE7 >= lonMin && p.lonE7 <= lonMax);
        } else {
            // caso antimeridiano: [lonMax..+180] U [-180..lonMin]
            bool inRight = (p.lonE7 >= lonMax && p.lonE7 <= LON_MAX);
            bool inLeft  = (p.lonE7 >= LON_MIN && p.lonE7 <= lonMin);
            return inRight || inLeft;
        }
    }

    // ---- helpers ----
    function _requireValid(PackedPosition calldata p) private pure {
        if (p.latE7 < LAT_MIN || p.latE7 > LAT_MAX) revert InvalidLat(p.latE7);
        if (p.lonE7 < LON_MIN || p.lonE7 > LON_MAX) revert InvalidLon(p.lonE7);
    }

}