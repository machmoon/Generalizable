#!/usr/bin/env python3
"""Download MaxMind's GeoLite2-City database, for the analytics visitor map.

The file is ~60MB and MaxMind's licence does not allow redistributing it, so it
is not in the repo and each deploy fetches its own copy.

You need a free MaxMind account and a licence key:

    1. Sign up at https://www.maxmind.com/en/geolite2/signup
    2. Account > Manage License Keys > Generate new license key
    3. Put it in the environment as MAXMIND_LICENSE_KEY

Then:

    python scripts/download_geolite.py

It writes flask-server/data/GeoLite2-City.mmdb (or GEOIP_DB_PATH if set), via a
temporary file so an interrupted download can't leave a truncated database in
place of a working one. Re-run it every month or two: addresses get reassigned,
and a year-old database quietly gets less accurate rather than failing.

Without the file the site works fine — locations simply aren't recorded and the
map says so. See services/geoip.py.
"""

import argparse
import io
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import geoip  # noqa: E402

EDITION = "GeoLite2-City"
URL = (
    "https://download.maxmind.com/app/geoip_download"
    f"?edition_id={EDITION}&license_key={{key}}&suffix=tar.gz"
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=None,
                        help="Where to write the .mmdb (default: GEOIP_DB_PATH, "
                             "else flask-server/data/GeoLite2-City.mmdb)")
    parser.add_argument("--license-key", default=os.environ.get("MAXMIND_LICENSE_KEY"),
                        help="MaxMind licence key (default: $MAXMIND_LICENSE_KEY)")
    args = parser.parse_args()

    if not args.license_key:
        print("No licence key. Set MAXMIND_LICENSE_KEY or pass --license-key.\n"
              "Get one free at https://www.maxmind.com/en/geolite2/signup",
              file=sys.stderr)
        return 2

    out = args.out or geoip.db_path()
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

    print(f"Downloading {EDITION} …")
    try:
        with urllib.request.urlopen(URL.format(key=args.license_key), timeout=120) as resp:
            payload = resp.read()
    except Exception as e:
        # A wrong key comes back as a 401 here, which is the most likely failure
        # and worth naming rather than leaving as a bare traceback.
        print(f"Download failed: {type(e).__name__}: {e}\n"
              "A 401 means the licence key is wrong or has been revoked.",
              file=sys.stderr)
        return 1

    # The archive is a dated directory containing the .mmdb; the date changes
    # every release, so pull the member out by extension rather than by path.
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as tar:
        member = next((m for m in tar.getmembers() if m.name.endswith(".mmdb")), None)
        if member is None:
            print("No .mmdb inside the archive — did the download return an error page?",
                  file=sys.stderr)
            return 1
        source = tar.extractfile(member)
        if source is None:
            print("Couldn't read the .mmdb out of the archive.", file=sys.stderr)
            return 1

        # Written beside the destination and moved into place, so a half-written
        # file never becomes the database the server reads.
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(out)),
                                   suffix=".mmdb.part")
        try:
            with os.fdopen(fd, "wb") as dest:
                shutil.copyfileobj(source, dest)
            os.replace(tmp, out)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    size_mb = os.path.getsize(out) / (1024 * 1024)
    print(f"Wrote {out} ({size_mb:.0f} MB). Restart the backend to pick it up.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
