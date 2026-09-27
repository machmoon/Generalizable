"""Turning a client IP into a place, offline.

Reads MaxMind's GeoLite2-City database from disk. Nothing leaves this server:
the alternative — an HTTP lookup per address against ip-api.com or similar —
would mean handing every visitor's IP to a third party, which is a poor trade
for a chart on an admin page, and it rate-limits besides.

**A missing database is a supported state.** The .mmdb is not in the repo (it is
50MB and licensed), so a fresh clone, a dev machine, and a deploy that hasn't
run scripts/download_geolite.py all have no file. Every lookup then returns
None, the location columns stay null, and the map says it has nothing to show.
It does not raise, and it does not stop events being recorded — analytics that
break the site they measure are worse than analytics with a blank map.

Accuracy, so the dashboard isn't read as more than it is: GeoLite2 resolves to a
city at best, the coordinates are the city's centre rather than the visitor's
position, and VPNs, cloud hosts and mobile carriers routinely resolve somewhere
other than where the person is.
"""

import ipaddress
import os
import threading
from functools import lru_cache

DEFAULT_DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data",
                               "GeoLite2-City.mmdb")

_reader = None
_reader_lock = threading.Lock()
# The "there is no database" complaint is printed once, not per request.
_warned = False


def db_path() -> str:
    return os.environ.get("GEOIP_DB_PATH") or DEFAULT_DB_PATH


def _dev_ip() -> str | None:
    """A public address to stand in for local ones, for development only.

    On a developer's machine every request arrives from 127.0.0.1, which has no
    location and never will — so the map is permanently empty and there is no
    way to see whether it works. Setting GEOIP_DEV_IP to any public address
    makes local traffic resolve as if it came from there.

    Never set this in production: it would rewrite real visitors' locations to
    one place. It only ever applies to addresses that are already unroutable,
    so even if it were set, a genuine visitor's address is untouched.
    """
    return os.environ.get("GEOIP_DEV_IP") or None


def _get_reader():
    """The shared Reader, or None if there isn't one to be had.

    Opened once and kept: the file is memory-mapped, so a single reader is both
    cheap and safe to share across gunicorn's threads.
    """
    global _reader, _warned
    if _reader is not None:
        return _reader

    with _reader_lock:
        if _reader is not None:
            return _reader

        path = db_path()
        if not os.path.exists(path):
            if not _warned:
                _warned = True
                print(
                    f"[geoip] no GeoLite2 database at {path} — visitor locations "
                    "will not be recorded. Run scripts/download_geolite.py to "
                    "install one.",
                    flush=True,
                )
            return None

        try:
            import geoip2.database
            _reader = geoip2.database.Reader(path)
        except Exception as e:
            if not _warned:
                _warned = True
                print(f"[geoip] couldn't open {path}: {type(e).__name__}: {e}", flush=True)
            return None
    return _reader


def reset_for_tests() -> None:
    """Drop the cached reader and the memoised lookups."""
    global _reader, _warned
    with _reader_lock:
        if _reader is not None:
            try:
                _reader.close()
            except Exception:
                pass
        _reader = None
        _warned = False
    lookup.cache_clear()


def is_public(ip: str) -> bool:
    """False for anything there is no point looking up: malformed, loopback,
    private ranges, link-local. In development every request is one of these."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (addr.is_private or addr.is_loopback or addr.is_link_local
                or addr.is_multicast or addr.is_reserved or addr.is_unspecified)


# Sized for the working set of a small site: a day's distinct visitors fit
# comfortably, and a repeat visitor's every event is then a dict hit rather than
# a database read.
@lru_cache(maxsize=4096)
def lookup(ip: str | None) -> dict | None:
    """Country/region/city/lat/lon for an address, or None.

    None means "no location to record", never an error: an unroutable address,
    no database installed, or an address the database has nothing for. All three
    are ordinary.
    """
    if not ip or not is_public(ip):
        # Only ever substituted for an address that has no location anyway, so
        # this cannot rewrite a real visitor's country even if it is left set.
        stand_in = _dev_ip()
        if not stand_in or not is_public(stand_in):
            return None
        ip = stand_in

    reader = _get_reader()
    if reader is None:
        return None

    try:
        found = reader.city(ip)
    except Exception:
        # geoip2 raises AddressNotFoundError for addresses it doesn't cover,
        # which is a normal outcome rather than a failure worth logging per hit.
        return None

    # Names come from the database's English localisation; a country with no
    # English name is stored by its code alone rather than dropped.
    subdivision = found.subdivisions.most_specific if found.subdivisions else None
    return {
        "country_code": found.country.iso_code,
        "country_name": found.country.names.get("en") if found.country.names else None,
        "region": subdivision.names.get("en") if subdivision and subdivision.names else None,
        "city": found.city.names.get("en") if found.city.names else None,
        "latitude": found.location.latitude,
        "longitude": found.location.longitude,
    }


# ---- device, which is the other thing the request tells us -----------------
#
# Here rather than in its own module because it answers the same question the
# rest of this file does — what can be said about a visitor from the request
# itself — and it is fifteen lines.

def device_type(user_agent: str | None) -> str | None:
    """"desktop", "mobile", "tablet", or None.

    A substring check, not a UA-parsing library. The three buckets the dashboard
    draws are coarse enough that a full parser (and its monthly-updated
    regex database) would be answering a much harder question than the one being
    asked. Order matters: an Android tablet's UA also says "Android", and iPads
    since iOS 13 announce themselves as Macs — which this deliberately does not
    try to unpick, because the guesswork would be worse than the bucket.
    """
    if not user_agent:
        return None
    ua = user_agent.lower()
    if "ipad" in ua or ("android" in ua and "mobile" not in ua) or "tablet" in ua:
        return "tablet"
    if "mobi" in ua or "iphone" in ua or "ipod" in ua or "android" in ua:
        return "mobile"
    if "mozilla" in ua or "webkit" in ua or "gecko" in ua:
        return "desktop"
    # curl, a scraper, a health check: not a device anyone is browsing from.
    return None
