"""geoip: what it refuses to look up, what it does without a database, and the
User-Agent buckets.

There is no GeoLite2 file in the repo, so these tests cover the paths that don't
need one — which is most of what matters. The lookups themselves are MaxMind's
and are not worth re-testing here; that the absence of their database can't take
the site down very much is.
"""

import pytest

from services import geoip


@pytest.fixture(autouse=True)
def clean():
    geoip.reset_for_tests()
    yield
    geoip.reset_for_tests()


# ---- what is worth looking up ----------------------------------------------

@pytest.mark.parametrize("ip", [
    "127.0.0.1",       # loopback — every local dev request
    "::1",
    "10.0.0.4",        # private ranges, and what nginx reports without x_for
    "192.168.1.20",
    "172.16.3.9",
    "169.254.1.1",     # link-local
    "0.0.0.0",
    "not-an-ip",
    "999.1.1.1",
    "",
])
def test_unroutable_and_malformed_addresses_are_not_public(ip):
    assert geoip.is_public(ip) is False


@pytest.mark.parametrize("ip", ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"])
def test_real_addresses_are_public(ip):
    assert geoip.is_public(ip) is True


def test_lookup_returns_none_for_addresses_worth_nothing():
    assert geoip.lookup(None) is None
    assert geoip.lookup("") is None
    assert geoip.lookup("127.0.0.1") is None
    assert geoip.lookup("garbage") is None


def test_a_missing_database_is_quiet_rather_than_fatal(monkeypatch, tmp_path, capsys):
    """A deploy that never ran download_geolite.py should record events with no
    location, not fail to record them."""
    monkeypatch.setenv("GEOIP_DB_PATH", str(tmp_path / "nothing-here.mmdb"))
    geoip.reset_for_tests()

    assert geoip.lookup("8.8.8.8") is None
    assert geoip.lookup("1.1.1.1") is None

    # Complained once, not once per address.
    assert capsys.readouterr().out.count("no GeoLite2 database") == 1


def test_a_corrupt_database_is_also_survivable(monkeypatch, tmp_path):
    bad = tmp_path / "GeoLite2-City.mmdb"
    bad.write_bytes(b"this is not an mmdb")
    monkeypatch.setenv("GEOIP_DB_PATH", str(bad))
    geoip.reset_for_tests()

    assert geoip.lookup("8.8.8.8") is None


# ---- device buckets --------------------------------------------------------

@pytest.mark.parametrize("ua,expected", [
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
     "(KHTML, like Gecko) Chrome/126.0 Safari/537.36", "desktop"),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
     "(KHTML, like Gecko) Chrome/126.0 Safari/537.36", "desktop"),
    ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
     "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "mobile"),
    ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
     "(KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36", "mobile"),
    ("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
     "(KHTML, like Gecko) Version/17.5 Safari/604.1", "tablet"),
    # Android without "Mobile" is the convention for a tablet.
    ("Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 "
     "(KHTML, like Gecko) Chrome/126.0 Safari/537.36", "tablet"),
])
def test_device_buckets(ua, expected):
    assert geoip.device_type(ua) == expected


@pytest.mark.parametrize("ua", [None, "", "curl/8.4.0", "python-requests/2.32.3"])
def test_non_browsers_get_no_device(ua):
    """A scraper or a health check isn't a device anyone is browsing from, and
    counting it as a desktop would put it in the ring chart."""
    assert geoip.device_type(ua) is None
