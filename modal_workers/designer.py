"""AI body design: Gemini models a product's mechanical body as primitive solids.

Python twin of pcb-studio/server/chassis.ts (same prompt, schema and cleaning),
so the Modal worker can design and build a product in one job. The result goes
into ``SystemDesign.structure`` and product.build_product turns every primitive
into a filleted CadQuery solid.
"""

from __future__ import annotations

import json
import hashlib
import math
import os
from pathlib import Path
import tempfile
import time
from typing import Any

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"
SHAPES = ("box", "cyl", "ring", "sphere")
MATS = ("metal", "plastic", "rubber", "carbon", "clear")

SYSTEM = """You are a mechanical designer. Model the physical body of the requested product as primitive solids for a 3D viewer.
Units are millimetres. y is up. The product is centred on the origin. Real-world proportions.
A custom PCB lies flat, centred at the origin, at the given height. Listed catalog devices already have existing catalog meshes at the given positions; do not duplicate or redesign them. Add custom mechanical peripherals (guides, handles, brackets, tooling) when the brief calls for them. Build the body around them: do not bury the PCB inside a closed solid, leave the top open or use 'clear' covers.
Shapes:
- box: size = [width x, height y, depth z]
- cyl: size = [radius, height, 0], axis along y before rotation
- ring: size = [ring radius, tube radius, 0], lies in the x-y plane (faces z) before rotation
- sphere: size = [radius, 0, 0]
rot is [x, y, z] in degrees. Set spin true only for parts that rotate in use (rotors, wheels, fans).
Model what makes the product recognisable: frame, shell walls, arms, wheels, legs, lenses, straps, handles, nozzles. Prefer 12 to 32 parts, maximum 60. Omit unnecessary detail. Keep everything within 400 mm of the origin."""

_NUM3 = {"type": "ARRAY", "items": {"type": "NUMBER"}, "minItems": 3, "maxItems": 3}
SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "name": {"type": "STRING"},
        "parts": {
            "type": "ARRAY",
            "maxItems": 60,
            "items": {
                "type": "OBJECT",
                "properties": {
                    "label": {"type": "STRING"},
                    "shape": {"type": "STRING", "enum": list(SHAPES)},
                    "size": _NUM3,
                    "pos": _NUM3,
                    "rot": _NUM3,
                    "mat": {"type": "STRING", "enum": list(MATS)},
                    "spin": {"type": "BOOLEAN"},
                },
                "required": ["shape", "size", "pos", "mat"],
            },
        },
    },
    "required": ["parts"],
}


def _vec(v: Any, limit: float) -> list[float] | None:
    if not isinstance(v, list) or len(v) < 3:
        return None
    out = []
    for n in v[:3]:
        if not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n):
            return None
        out.append(max(-limit, min(limit, float(n))))
    return out


def clean_parts(raw: Any) -> list[dict[str, Any]]:
    """Keep only well-formed parts, so a bad model answer can never break the build."""
    items = raw.get("parts") if isinstance(raw, dict) else None
    parts = []
    for p in (items if isinstance(items, list) else [])[:120]:
        if not isinstance(p, dict):
            continue
        shape, mat = p.get("shape"), p.get("mat")
        size, pos = _vec(p.get("size"), 800), _vec(p.get("pos"), 600)
        if shape not in SHAPES or mat not in MATS or not size or not pos or size[0] <= 0:
            continue
        if shape != "sphere" and size[1] <= 0:
            continue
        if shape == "box" and size[2] <= 0:
            continue
        if shape == "ring" and size[1] >= size[0]:
            continue
        part = {"shape": shape, "mat": mat, "size": size, "pos": pos}
        if (rot := _vec(p.get("rot"), 360)) is not None:
            part["rot"] = rot
        if p.get("spin") is True:
            part["spin"] = True
        if isinstance(p.get("label"), str):
            part["label"] = p["label"][:60]
        parts.append(part)
    return parts


def layout_text(system: dict[str, Any]) -> str:
    lines = [f"PCB height above origin: {system.get('pcbHeight', 12)} mm.", "Devices:"]
    for d in system.get("devices") or []:
        lines.append(f"- {d.get('label')} at x={d.get('x')}, y={d.get('y')}, z={d.get('z')}")
    return "\n".join(lines)


def design_body(brief: str, system: dict[str, Any], *, api_key: str, model: str, timeout: float = 20, cache_dir: Path | None = None) -> dict[str, Any]:
    """Ask Gemini for the body. Returns {parts, name, model, ms, usage}."""
    import httpx

    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": f"Product: {brief.strip()[:2000]}\n\n{layout_text(system)[:3000]}"}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": SCHEMA, "temperature": 0.4},
    }
    # Look up the design BEFORE inference; caching only the built mesh still pays
    # Gemini latency on every request (and stochastic answers miss that cache).
    cache_path = None
    if cache_dir is not None:
        key = hashlib.sha256(json.dumps([model, body, api_key], sort_keys=True).encode()).hexdigest()
        cache_path = cache_dir / f"{key}.json"
        try:
            cached = json.loads(cache_path.read_text())
            if clean_parts(cached):
                return {**cached, "cache_hit": True}
        except (OSError, ValueError, TypeError):
            pass
    started = time.monotonic()
    response = httpx.post(
        f"{ENDPOINT}/{model}:generateContent",
        headers={"x-goog-api-key": api_key, "content-type": "application/json"},
        json=body,
        timeout=timeout,
    )
    if response.status_code != 200:
        raise RuntimeError(f"Gemini {response.status_code}: {response.text[:300]}")
    data = response.json()
    text = "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])
    raw = json.loads(text)
    usage = data.get("usageMetadata", {})
    result = {
        "name": raw.get("name") if isinstance(raw, dict) else None,
        "parts": clean_parts(raw),
        "model": model,
        "ms": int((time.monotonic() - started) * 1000),
        "usage": {"prompt_tokens": usage.get("promptTokenCount"), "output_tokens": usage.get("candidatesTokenCount")},
        "cache_hit": False,
    }
    if cache_path is not None and result["parts"]:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        # Readers see a complete answer even when independent workers finish together.
        with tempfile.NamedTemporaryFile(mode="w", dir=cache_path.parent, delete=False) as file:
            json.dump(result, file)
            temporary = Path(file.name)
        temporary.replace(cache_path)
    return result


def default_model() -> str:
    return os.environ.get("FORGE_BODY_MODEL") or os.environ.get("GEMINI_FAST_MODEL") or "gemini-4-carbon"
