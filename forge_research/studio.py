"""Local web entry point for the FORGE research harness."""

import asyncio
import json
import logging
import os
from collections import OrderedDict
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

import uvicorn
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google.adk.agents.invocation_context import LlmCallsLimitExceededError
from google.genai.errors import APIError
from pydantic import BaseModel, Field, ValidationError

from .catalog import ResearchError
from .geometry import (
    AssemblyManifest,
    AssemblyParameters,
    GeometryError,
    build_assembly,
    export_glb,
)
from .models import Part, Requirements, ResearchReport
from .offline import DEMO_BRIEF, DemoModel
from .workflow import Progress, run_research, stage_event

WEB = Path(__file__).with_name("web")
logger = logging.getLogger(__name__)
app = FastAPI(title="FORGE Studio", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=WEB), name="static")


class ResearchRequest(BaseModel):
    mode: Literal["live", "sample"]
    brief: str = Field(default="", max_length=4000)


class DeviceSpecification(BaseModel):
    """Versioned requirements, part instances, and editable assembly parameters."""

    schema_version: Literal[1] = 1
    requirements: Requirements
    parts_by_instance: dict[str, Part]
    mechanical: AssemblyParameters


class Prototype(BaseModel):
    project_id: UUID
    revision: int
    device_spec: DeviceSpecification
    manifest: AssemblyManifest
    glb_url: str


class StudioReport(ResearchReport):
    prototype: Prototype | None = None
    prototype_error: str | None = None


class AssemblyEdit(BaseModel):
    base_revision: int = Field(ge=1)
    wrist_circumference_mm: float = Field(allow_inf_nan=False)


@dataclass(frozen=True)
class PrototypeProject:
    report: ResearchReport
    prototype: Prototype
    glb: bytes


projects: OrderedDict[UUID, PrototypeProject] = OrderedDict()


def publish_prototype(
    report: ResearchReport,
    project_id: UUID,
    revision: int,
    parameters: AssemblyParameters | None = None,
    *,
    progress: Progress | None = None,
) -> Prototype:
    specification = DeviceSpecification(
        requirements=report.requirements,
        parts_by_instance={
            ("board" if part.role == "controller" else "sensor-1"): part
            for part in report.review.selected_parts
        },
        mechanical=parameters if parameters is not None else AssemblyParameters(),
    )
    if progress is not None:
        progress(
            stage_event("geometry", "running", detail="Generating the parametric assembly.")
        )
    try:
        manifest = build_assembly(report, specification.mechanical)
    except GeometryError as error:
        if progress is not None:
            progress(stage_event("geometry", "failed", detail=str(error)))
            progress(
                stage_event("export", "skipped", detail="No validated assembly to export.")
            )
        raise
    specification.mechanical = manifest.parameters
    if progress is not None:
        progress(
            stage_event(
                "geometry",
                "completed",
                data={
                    "path": "parametric",
                    "node_count": len(manifest.nodes),
                    "findings": [
                        finding.model_dump(mode="json") for finding in manifest.findings
                    ],
                },
            )
        )
        progress(stage_event("export", "running", detail="Packaging the GLB viewer model."))
    try:
        glb = export_glb(manifest)
    except GeometryError as error:
        if progress is not None:
            progress(stage_event("export", "failed", detail=str(error)))
        raise
    prototype = Prototype(
        project_id=project_id,
        revision=revision,
        device_spec=specification,
        manifest=manifest,
        glb_url=f"/api/prototypes/{project_id}/model.glb?revision={revision}",
    )
    projects[project_id] = PrototypeProject(report, prototype, glb)
    projects.move_to_end(project_id)
    if len(projects) > 32:
        projects.popitem(last=False)
    if progress is not None:
        progress(
            stage_event("export", "completed", data={"format": "GLB", "byte_count": len(glb)})
        )
    return prototype


def require_current_project(project_id: UUID, revision: int) -> PrototypeProject:
    project = projects.get(project_id)
    if project is None:
        raise HTTPException(404, "This prototype expired. Run the brief again.")
    if revision != project.prototype.revision:
        raise HTTPException(
            409, "This prototype changed. Reload your report before editing it."
        )
    return project


def configured_model() -> str | None:
    model = os.getenv("FORGE_GEMINI_MODEL", "").strip()
    has_key = any(os.getenv(name, "").strip() for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"))
    return model if has_key and model.startswith("gemini-") else None


@app.get("/")
def home() -> FileResponse:
    return FileResponse(WEB / "index.html")


@app.get("/api/session")
def session() -> dict:
    return {"live": configured_model() is not None, "sample_brief": DEMO_BRIEF}


@app.post("/api/research")
async def research(request: ResearchRequest) -> StudioReport:
    return await run_studio_research(request)


async def run_studio_research(
    request: ResearchRequest, progress: Progress | None = None
) -> StudioReport:
    try:
        if request.mode == "sample":
            report = await run_research(
                DEMO_BRIEF, DemoModel(), mode="offline", progress=progress
            )
        else:
            if not request.brief.strip():
                raise HTTPException(422, "Enter a design brief.")
            model = configured_model()
            if model is None:
                raise HTTPException(
                    503,
                    "Live research needs Gemini configured on the server. You can run the offline sample.",
                )
            report = await run_research(request.brief, model, mode="gemini", progress=progress)
    except ResearchError as error:
        raise HTTPException(
            502, "Research could not finish. Try again or run the sample."
        ) from error
    except (TimeoutError, LlmCallsLimitExceededError) as error:
        raise HTTPException(504, "Research timed out. Try again.") from error
    except APIError as error:
        if error.code in (401, 403) or "API_KEY_INVALID" in str(error):
            message = (
                "Gemini rejected the server credential. Update it or run the offline sample."
            )
        elif error.code == 429:
            message = (
                "Gemini is temporarily rate limited. Try again or run the offline sample."
            )
        else:
            message = (
                "Gemini could not complete the request. Try again or run the offline sample."
            )
        raise HTTPException(502, message) from error

    result = StudioReport(**report.model_dump())
    if report.review.status == "candidate":
        try:
            result.prototype = publish_prototype(report, uuid4(), 1, progress=progress)
        except GeometryError as error:
            result.prototype_error = str(error)
    elif progress is not None:
        progress(
            stage_event(
                "geometry", "skipped", detail="The parts review did not clear a build."
            )
        )
        progress(stage_event("export", "skipped", detail="No validated assembly to export."))
    return result


async def research_events(request: ResearchRequest) -> AsyncIterator[str]:
    events: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()
    active_stage: str | None = None

    def publish(event: dict[str, object]) -> None:
        nonlocal active_stage
        if event["type"] == "stage":
            stage = str(event["stage"])
            if event["status"] == "running":
                active_stage = stage
            elif active_stage == stage:
                active_stage = None
        events.put_nowait(event)

    def publish_error(message: str) -> None:
        if active_stage is not None:
            publish(stage_event(active_stage, "failed", detail=message))
        publish({"type": "error", "message": message})

    async def produce() -> None:
        try:
            report = await run_studio_research(request, publish)
            publish({"type": "report", "report": report.model_dump(mode="json")})
        except HTTPException as error:
            publish_error(str(error.detail))
        except Exception:
            logger.exception("Unable to complete the research stream.")
            publish_error("Research did not finish. Try again or run the offline sample.")
        finally:
            events.put_nowait(None)

    task = asyncio.create_task(produce())
    try:
        yield json.dumps({"type": "run", "mode": request.mode}) + "\n"
        while (event := await events.get()) is not None:
            yield json.dumps(event) + "\n"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@app.post("/api/research/stream")
async def stream_research(request: ResearchRequest) -> StreamingResponse:
    return StreamingResponse(
        research_events(request),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@app.get("/api/prototypes/{project_id}/model.glb")
async def get_model(project_id: UUID, revision: int) -> Response:
    project = require_current_project(project_id, revision)
    return Response(project.glb, media_type="model/gltf-binary")


@app.post("/api/prototypes/{project_id}/revisions")
async def revise_prototype(project_id: UUID, edit: AssemblyEdit) -> Prototype:
    project = require_current_project(project_id, edit.base_revision)
    previous = project.prototype.device_spec.mechanical
    try:
        parameters = AssemblyParameters(
            wrist_circumference_mm=edit.wrist_circumference_mm,
            wall_mm=previous.wall_mm,
            clearance_mm=previous.clearance_mm,
        )
        return publish_prototype(
            project.report, project_id, edit.base_revision + 1, parameters
        )
    except (GeometryError, ValidationError) as error:
        message = (
            str(error) if isinstance(error, GeometryError) else "Enter a supported wrist size."
        )
        raise HTTPException(422, message) from error


if __name__ == "__main__":
    os.environ["GOOGLE_GENAI_USE_ENTERPRISE"] = "false"
    os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "false"
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("FORGE_PORT", "8000")))
