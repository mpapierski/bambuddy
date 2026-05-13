"""Unit coverage for slice dispatch request-shape guards."""

from __future__ import annotations

import io
import json
import zipfile
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from backend.app.api.routes import settings as settings_route
from backend.app.api.routes.library import (
    _ensure_process_profile_compatible_with_printer,
    _infer_device_kind_from_profile_json,
    _run_slicer_with_fallback,
)
from backend.app.schemas.slicer import PresetRef, SliceRequest
from backend.app.services import preset_resolver
from backend.app.services import slicer_api as slicer_api_module
from backend.app.services.slicer_api import SlicerApiServerError


def _make_project_3mf(settings_payload: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
        zf.writestr("Metadata/project_settings.config", json.dumps(settings_payload))
    return buf.getvalue()


def test_infers_device_kind_from_profile_json_fields():
    assert (
        _infer_device_kind_from_profile_json(json.dumps({"printer_model": "Bambu Lab X1 Carbon"}))
        == "X1C"
    )
    assert (
        _infer_device_kind_from_profile_json(json.dumps({"compatible_printers": ["Bambu Lab A1 Mini"]}))
        == "A1 Mini"
    )
    assert _infer_device_kind_from_profile_json("Bambu Lab P1S 0.4 nozzle") == "P1S"


def test_augments_process_profile_with_selected_printer_compatibility():
    updated = _ensure_process_profile_compatible_with_printer(
        json.dumps({"name": "0.20mm Standard @BBL X1C", "type": "process"}),
        json.dumps(
            {
                "name": "Bambu Lab X1 Carbon 0.4 nozzle",
                "inherits": "Bambu Lab X1 Carbon 0.4 nozzle",
                "printer_model": "Bambu Lab X1 Carbon",
                "type": "machine",
            }
        ),
    )

    compatible = json.loads(updated)["compatible_printers"]
    assert "Bambu Lab X1 Carbon 0.4 nozzle" in compatible
    assert "Bambu Lab X1 Carbon" in compatible


@pytest.mark.asyncio
async def test_embedded_filament_mode_rejects_non_3mf_sources():
    request = SliceRequest(
        printer_preset=PresetRef(source="standard", id="Bambu Lab X1 Carbon 0.4 nozzle"),
        process_preset=PresetRef(source="standard", id="0.20mm Standard @BBL X1C"),
        filament_mode="embedded",
    )

    with pytest.raises(HTTPException) as exc:
        await _run_slicer_with_fallback(
            None,  # type: ignore[arg-type]
            model_bytes=b"solid cube",
            model_filename="Cube.stl",
            request=request,
        )

    assert exc.value.status_code == 400
    assert "3MF" in exc.value.detail


@pytest.mark.asyncio
async def test_cross_device_profile_failure_does_not_fallback_to_embedded(monkeypatch):
    """A failed cross-device profile slice must not emit source-device gcode.

    The embedded fallback intentionally uses the 3MF's own settings. That is
    useful for same-device CLI crashes, but wrong for A1 Mini -> X1C where the
    fallback output is guaranteed to be sliced for the source printer.
    """

    async def fake_get_setting(_db, key: str):
        values = {
            "preferred_slicer": "bambu_studio",
            "bambu_studio_api_url": "http://sidecar.test",
        }
        return values.get(key)

    async def fake_resolve_preset_ref(_db, _user, _ref, slot: str):
        if slot == "printer":
            return json.dumps({"printer_model": "Bambu Lab X1 Carbon", "type": "machine"})
        if slot == "process":
            return json.dumps({"name": "0.20mm Standard @BBL X1C", "type": "process"})
        return json.dumps({"name": "Bambu PLA Basic", "type": "filament"})

    service = Mock()
    service.slice_with_profiles = AsyncMock(
        side_effect=SlicerApiServerError("current 3mf file does not support the new printer"),
    )
    service.slice_without_profiles = AsyncMock()
    service.close = AsyncMock()

    monkeypatch.setattr(settings_route, "get_setting", fake_get_setting)
    monkeypatch.setattr(preset_resolver, "resolve_preset_ref", fake_resolve_preset_ref)
    monkeypatch.setattr(slicer_api_module, "SlicerApiService", Mock(return_value=service))

    request = SliceRequest(
        printer_preset=PresetRef(source="standard", id="Bambu Lab X1 Carbon 0.4 nozzle"),
        process_preset=PresetRef(source="standard", id="0.20mm Standard @BBL X1C"),
        filament_mode="embedded",
    )

    with pytest.raises(HTTPException) as exc:
        await _run_slicer_with_fallback(
            None,  # type: ignore[arg-type]
            model_bytes=_make_project_3mf({"printer_model": "Bambu Lab A1 Mini"}),
            model_filename="A1MiniProject.3mf",
            request=request,
        )

    assert exc.value.status_code == 502
    service.slice_with_profiles.assert_awaited_once()
    service.slice_without_profiles.assert_not_awaited()
