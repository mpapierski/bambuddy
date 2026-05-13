"""Unit coverage for slice dispatch request-shape guards."""

import pytest
from fastapi import HTTPException

from backend.app.api.routes.library import _run_slicer_with_fallback
from backend.app.schemas.slicer import PresetRef, SliceRequest


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
