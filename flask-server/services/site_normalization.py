"""Normalize the country codes stored in the dataset's site-nationality field."""

from __future__ import annotations

import re


_SITE_SPLIT_RE = re.compile(r"[;,|/、，·・]+")
_UNKNOWN_VALUES = {"", "unknown", "nan", "none", "n/a", "na", "(blank)", "(null)"}

_SITE_CODE_ALIASES = {
    "USA": "US",
    "U.S.": "US",
    "U S A": "US",
    "GB": "UK",
    "U.K.": "UK",
}

_SITE_COUNTRY_LABELS = {
    "BR": "Brazil",
    "CA": "Canada",
    "CH": "Switzerland",
    "CN": "China",
    "DE": "Germany",
    "FR": "France",
    "IL": "Israel",
    "NL": "Netherlands",
    "PL": "Poland",
    "TR": "Türkiye",
    "UK": "United Kingdom",
    "US": "United States",
}


def normalize_site_code(value: object) -> str:
    """Normalize one site-nationality token to the code used by the app."""
    cleaned = " ".join(str(value or "").strip().split()).upper()
    if cleaned.casefold() in _UNKNOWN_VALUES:
        return ""
    return _SITE_CODE_ALIASES.get(cleaned, cleaned)


def split_site_codes(value: object) -> tuple[str, ...]:
    """Split a metadata value into unique country codes, preserving source order."""
    raw = str(value or "").strip()
    if raw.casefold() in _UNKNOWN_VALUES:
        return ()

    codes: list[str] = []
    for token in _SITE_SPLIT_RE.split(raw):
        code = normalize_site_code(token)
        if code and code not in codes:
            codes.append(code)
    return tuple(codes)


def site_country_label(code: object) -> str:
    """Return a readable country name while keeping unknown codes usable."""
    normalized = normalize_site_code(code)
    return _SITE_COUNTRY_LABELS.get(normalized, normalized)
