"""Canonical manufacturer names used by dataset facets and filters."""

from __future__ import annotations


_MANUFACTURER_ALIASES = {
    "ge": "GE Medical Systems",
    "ge medical systems": "GE Medical Systems",
    "philips": "Philips",
    "philips medical systems": "Philips",
    "phillips": "Philips",
    "phillips medical systems": "Philips",
    "siemens": "Siemens",
    "toshiba": "Toshiba",
}

_UNKNOWN_VALUES = {"", "unknown", "nan", "none", "n/a", "na"}


def canonicalize_manufacturer(value: object) -> str:
    """Return one consistently cased label for known manufacturer aliases."""
    if value is None:
        return ""

    cleaned = " ".join(str(value).strip().split())
    key = cleaned.casefold()
    if key in _UNKNOWN_VALUES:
        return ""
    return _MANUFACTURER_ALIASES.get(key, cleaned)
