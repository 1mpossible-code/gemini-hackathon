from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl

Transport = Literal["ble", "wifi", "wired", "wireless", "other", "unspecified"]
PartRole = Literal["controller", "emg_sensor"]


class Requirements(BaseModel):
    application: Literal["emg_wearable", "unsupported"]
    budget_usd_cents: int | None = Field(default=None, ge=0)
    budget_exclusive: bool
    transport: Transport
    wrist_circumference_mm: int | None = Field(default=None, ge=1)
    gestures: list[str]
    unresolved: list[str]


class Quote(BaseModel):
    unit_price_usd_cents: int = Field(ge=0)
    vendor: str
    url: HttpUrl
    reviewed_on: date


class Part(BaseModel):
    id: str
    role: PartRole
    manufacturer: str
    sku: str
    name: str
    transports: list[Transport] = Field(default_factory=list)
    adc_pins: list[str] = Field(default_factory=list)
    sensor_rail_mv: int | None = None
    supply_range_mv: tuple[int, int] | None = None
    signal_output: Literal["analog_envelope"] | None = None
    technical_sources: list[HttpUrl] = Field(min_length=1)
    quote: Quote | None = None


class Proposal(BaseModel):
    controller_id: str | None = None
    sensor_id: str | None = None
    rationale: str


class Finding(BaseModel):
    check: str
    status: Literal["pass", "fail", "unknown"]
    detail: str


class CatalogReview(BaseModel):
    status: Literal["candidate", "blocked", "unsupported"]
    selected_parts: list[Part]
    core_subtotal_usd_cents: int | None = None
    findings: list[Finding]


class ReviewNotes(BaseModel):
    next_steps: list[str]


class TraceEvent(BaseModel):
    agent: str
    event: Literal["catalog_lookup", "completed"]
    part_ids: list[str] = Field(default_factory=list)


class ResearchReport(BaseModel):
    schema_version: Literal[1] = 1
    mode: Literal["offline", "gemini"]
    model: str
    brief: str
    requirements: Requirements
    proposal: Proposal
    catalog_snapshot: dict[str, Part]
    review: CatalogReview
    review_notes: ReviewNotes
    trace: list[TraceEvent]
