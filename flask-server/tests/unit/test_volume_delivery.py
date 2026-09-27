from pathlib import Path

from flask import Flask

import api.api_blueprint as api_routes


def test_dataset_volume_uses_only_approved_nginx_internal_path(tmp_path, monkeypatch):
    lowres_root = tmp_path / "lowres"
    volume = lowres_root / "image_only" / "PanTS_00000035" / "ct_lowres.nii.gz"
    volume.parent.mkdir(parents=True)
    volume.write_bytes(b"not-a-real-nifti")

    monkeypatch.setattr(api_routes, "LOWRES_ROOT", str(lowres_root))
    monkeypatch.setenv("BODYMAPS_ACCEL_REDIRECT_ENABLED", "true")

    app = Flask(__name__)
    with app.test_request_context("/"):
        response = api_routes._serve_dataset_volume(str(volume))

    assert response.status_code == 200
    assert response.headers["X-Accel-Redirect"] == (
        "/_bodymaps_volume_lowres/image_only/PanTS_00000035/ct_lowres.nii.gz"
    )
    assert response.headers["Cache-Control"] == "public, max-age=604800, immutable"
    assert response.headers["Cross-Origin-Resource-Policy"] == "cross-origin"


def test_dataset_volume_never_redirects_an_unmapped_path(tmp_path, monkeypatch):
    volume = Path(tmp_path) / "outside-approved-roots.nii.gz"
    volume.write_bytes(b"not-a-real-nifti")
    monkeypatch.setattr(api_routes, "LOWRES_ROOT", str(Path(tmp_path) / "lowres"))
    monkeypatch.setenv("BODYMAPS_ACCEL_REDIRECT_ENABLED", "true")

    app = Flask(__name__)
    with app.test_request_context("/"):
        response = api_routes._serve_dataset_volume(str(volume))

    assert "X-Accel-Redirect" not in response.headers
