"""Generation-stage compute: Modal CAD worker first, this machine as fallback.

Every job emits ``{"type": "compute", ...}`` events so the research screen can
show which worker ran, its declared resources and the measured results:

  provision -> running -> completed | failed | cancelled | skipped

If Modal is not configured, errors or times out, its job is cancelled (the HTTP
request is abandoned) and the same CadQuery code runs on this machine.

Resources are the ones declared on the Modal function (CPU only; no GPU is
requested because CadQuery tessellation does not use one). Durations and sizes
are measured, never estimated.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

from .usage import record_usage

Emit = Callable[[dict[str, object]], None]

# Must match the @app.function declaration of generate_enclosure in modal_workers/app.py.
MODAL_ENCLOSURE_RESOURCES = {"cpu": 2.0, "memory_mb": 2048, "gpu": None, "timeout_s": 300}
LOCAL_RESOURCES = {"cpu": float(os.cpu_count() or 1), "memory_mb": None, "gpu": None, "timeout_s": None}


def configured() -> bool:
    return bool(os.getenv("FORGE_MODAL_CAD_URL", "").strip() and os.getenv("FORGE_MODAL_TOKEN", "").strip())


def compute_event(job: str, event: str, **fields: object) -> dict[str, object]:
    return {"type": "compute", "job": job, "event": event, **fields}


def enclosure_spec(parts: list[Any], wall_mm: float, clearance_mm: float, name: str) -> dict[str, Any]:
    """Enclosure inputs from the selected parts' catalog dimensions (mm)."""
    # Catalog axis order varies by part; treat the longest side as length, the shortest as height.
    dims = [sorted(p.dimensions_mm, reverse=True) for p in parts if getattr(p, "dimensions_mm", None)]
    if not dims:
        raise ValueError("No selected part has catalog dimensions.")
    length = max(d[0] for d in dims)
    width = max(d[1] for d in dims)
    height = max(d[2] for d in dims)
    return {
        "id": name,
        "board": {"length": round(length, 2), "width": round(width, 2), "thickness": 1.6, "component_height": round(max(height - 1.6, 8.0), 2)},
        "wall": wall_mm,
        "clearance": clearance_mm,
        "cutouts": [{"id": "usb", "face": "-x", "width": 10.0, "height": 4.0, "offset_z": 0.5}],
        "strap_slots": {"width": 22.0, "height": 3.0},
    }


ROOT = Path(__file__).resolve().parents[2]
LOCAL_CAD_TIMEOUT_S = 240


def _stats(data: dict[str, Any], files: dict[str, bytes], elapsed: float) -> dict[str, Any]:
    glb = data.get("glb") or {}
    return {
        "elapsed_s": round(elapsed, 2),
        "cache_hit": bool(data.get("cache_hit")),
        "spec_hash": str(data.get("spec_hash", ""))[:12],
        "triangles": glb.get("triangles"),
        "size_mm": glb.get("size_mm"),
        "nodes": glb.get("nodes"),
        "bytes": {k: len(v) for k, v in files.items()},
        "findings": data.get("findings") or [],
        "generator": data.get("generator"),
    }


def local_command() -> list[str] | None:
    """How this machine runs CadQuery: FORGE_LOCAL_CAD_PYTHON, else uv with a pinned cadquery."""
    if python := os.getenv("FORGE_LOCAL_CAD_PYTHON", "").strip():
        return [python]
    if uv := shutil.which("uv"):
        return [uv, "run", "--no-project", "--python", "3.12", "--with", "cadquery==2.8.0", "python"]
    return None


def run_local_enclosure(spec: dict[str, Any], emit: Emit | None = None, *, reason: str = "") -> dict[str, Any]:
    """Same CadQuery enclosure code as the Modal worker, on this machine's CPU."""
    say = emit or (lambda _event: None)
    command = local_command()
    say(compute_event("local-enclosure", "provision", provider="local", label="Local CAD worker (fallback)",
                      function="tools/local_enclosure.py", resources=LOCAL_RESOURCES,
                      detail=reason or "Generating the enclosure on this machine."))
    if command is None:
        detail = "No local CadQuery runtime (install uv or set FORGE_LOCAL_CAD_PYTHON)."
        say(compute_event("local-enclosure", "failed", provider="local", detail=detail))
        raise RuntimeError(detail)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="forge-enclosure-") as tmp:
        work = Path(tmp)
        (work / "spec.json").write_text(json.dumps(spec))
        say(compute_event("local-enclosure", "running", provider="local", detail="CadQuery: shell, standoffs, cutouts, STEP to GLB."))
        try:
            run = subprocess.run(
                [*command, str(ROOT / "tools" / "local_enclosure.py"), str(work / "spec.json"), str(work / "out")],
                cwd=ROOT, capture_output=True, text=True, timeout=LOCAL_CAD_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            detail = f"Local CadQuery took longer than {LOCAL_CAD_TIMEOUT_S} s."
            say(compute_event("local-enclosure", "failed", provider="local", detail=detail))
            raise RuntimeError(detail) from None
        if run.returncode != 0:
            detail = "Local CadQuery failed: " + (run.stderr.strip().splitlines() or ["no output"])[-1][:200]
            say(compute_event("local-enclosure", "failed", provider="local", detail=detail))
            raise RuntimeError(detail)
        data = json.loads(run.stdout.strip().splitlines()[-1])
        files = {name.rsplit(".", 1)[1]: (work / "out" / name).read_bytes()
                 for name in ("enclosure.glb", "enclosure.step", "enclosure.stl") if (work / "out" / name).exists()}
    stats = _stats(data, files, time.monotonic() - started)
    say(compute_event("local-enclosure", "completed", provider="local", stats=stats, detail="Generated STEP, STL and GLB locally."))
    return {"stats": stats, "files": files, "provider": "local"}


def generate_enclosure(spec: dict[str, Any], emit: Emit | None = None, *, modal_timeout: float = 120) -> dict[str, Any]:
    """Modal first. If Modal is missing, errors or times out, cancel it and let this machine generate."""
    say = emit or (lambda _event: None)
    if not configured():
        say(compute_event("modal-enclosure", "skipped", provider="modal", label="Modal CAD worker",
                          resources=MODAL_ENCLOSURE_RESOURCES, detail="Modal is not configured; using this machine."))
        return run_local_enclosure(spec, emit, reason="Modal not configured.")
    try:
        return {**run_enclosure(spec, emit, timeout=modal_timeout), "provider": "modal"}
    except Exception as error:  # any Modal failure hands the job to the local worker
        say(compute_event("modal-enclosure", "cancelled", provider="modal",
                          detail=f"Cancelled Modal job ({str(error)[:120]}). Local worker takes over."))
        return run_local_enclosure(spec, emit, reason="Modal failed; local fallback.")


def run_enclosure(spec: dict[str, Any], emit: Emit | None = None, *, timeout: float = 240) -> dict[str, Any]:
    """POST the spec to the deployed Modal endpoint. Returns metadata plus GLB bytes."""
    import httpx

    url = os.environ["FORGE_MODAL_CAD_URL"].strip()
    say = emit or (lambda _event: None)
    say(compute_event("modal-enclosure", "provision", provider="modal", label="Modal CAD worker",
                      function="generate_enclosure", resources=MODAL_ENCLOSURE_RESOURCES,
                      detail="Requesting a CadQuery container."))
    started = time.monotonic()
    say(compute_event("modal-enclosure", "running", provider="modal", detail="Container running CadQuery: shell, standoffs, cutouts, STEP to GLB."))
    try:
        response = httpx.post(url, json={"spec": spec, "_token": os.environ["FORGE_MODAL_TOKEN"].strip()}, timeout=timeout)
    except httpx.HTTPError as error:
        raise RuntimeError(f"Modal request failed: {type(error).__name__}") from error
    elapsed = time.monotonic() - started
    if response.status_code != 200:
        detail = f"Modal returned HTTP {response.status_code}."
        raise RuntimeError(detail)
    data = response.json()
    files = {k: base64.b64decode(v) for k, v in (data.pop("files", None) or {}).items()}
    stats = _stats(data, files, elapsed)
    record_usage("modal", "generate_enclosure", duration_ms=int(elapsed * 1000))
    say(compute_event("modal-enclosure", "completed", provider="modal", stats=stats,
                      detail="Cache hit; reused earlier geometry." if stats["cache_hit"] else "Generated STEP, STL and GLB."))
    return {"stats": stats, "files": files}
