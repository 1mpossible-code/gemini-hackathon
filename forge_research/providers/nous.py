"""Nous Research inference adapter.

Nous serves an OpenAI-compatible chat-completions API. ``NousLlm`` plugs it into
the existing Google ADK workflow as a ``BaseLlm`` so the requirements, sourcing
and reviewer agents run unchanged on Hermes models. ``nous_complete`` is the
plain text/JSON call used by the documentation and editorial agents.

Nous is only the model provider. Orchestration, tool execution and validation
stay in FORGE.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import httpx
from google.adk.models import BaseLlm, LlmCapabilities, LlmRequest, LlmResponse
from google.genai import types

from .usage import record_usage

DEFAULT_BASE_URL = "https://inference-api.nousresearch.com/v1"
DEFAULT_MODEL = "Hermes-4-70B"
TIMEOUT_S = 60.0


class NousError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def nous_api_key() -> str | None:
    key = os.getenv("NOUS_API_KEY", "").strip()
    return key or None


def nous_model() -> str:
    return os.getenv("FORGE_NOUS_MODEL", "").strip() or DEFAULT_MODEL


def nous_base_url() -> str:
    return (os.getenv("NOUS_BASE_URL", "").strip() or DEFAULT_BASE_URL).rstrip("/")


async def chat_completion(
    messages: list[dict[str, Any]],
    *,
    model: str,
    tools: list[dict[str, Any]] | None = None,
    temperature: float = 0.2,
    operation: str = "chat",
    api_key: str | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    key = api_key or nous_api_key()
    if key is None:
        raise NousError("NOUS_API_KEY is not configured on the server.")
    body: dict[str, Any] = {"model": model, "messages": messages, "temperature": temperature}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S, transport=transport) as client:
            response = await client.post(
                f"{nous_base_url()}/chat/completions",
                headers={"Authorization": f"Bearer {key}"},
                json=body,
            )
    except httpx.HTTPError as error:
        record_usage("nous", operation, model=model, ok=False, detail=type(error).__name__)
        raise NousError(f"Nous request failed: {type(error).__name__}") from error
    duration = int((time.monotonic() - started) * 1000)
    if response.status_code >= 400:
        record_usage(
            "nous", operation, model=model, ok=False, duration_ms=duration,
            detail=f"HTTP {response.status_code}",
        )
        raise NousError(f"Nous returned HTTP {response.status_code}.", response.status_code)
    data = response.json()
    usage = data.get("usage") or {}
    record_usage(
        "nous",
        operation,
        model=data.get("model") or model,
        duration_ms=duration,
        prompt_tokens=usage.get("prompt_tokens"),
        output_tokens=usage.get("completion_tokens"),
    )
    return data


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def extract_json_text(text: str) -> str:
    """Return the first JSON object or array in a model reply."""
    cleaned = _FENCE.sub("", text.strip()).strip()
    try:
        json.loads(cleaned)
        return cleaned
    except json.JSONDecodeError:
        pass
    decoder = json.JSONDecoder()
    for index, char in enumerate(cleaned):
        if char in "{[":
            try:
                value, _ = decoder.raw_decode(cleaned[index:])
            except json.JSONDecodeError:
                continue
            return json.dumps(value)
    raise NousError("The model reply did not contain JSON.")


def _schema_json(schema: Any) -> dict[str, Any] | None:
    if schema is None:
        return None
    if isinstance(schema, dict):
        return schema
    if isinstance(schema, type) and hasattr(schema, "model_json_schema"):
        return schema.model_json_schema()
    if isinstance(schema, types.Schema):
        return schema.json_schema.model_dump(mode="json", exclude_none=True)
    return None


def _declaration_tool(declaration: types.FunctionDeclaration) -> dict[str, Any]:
    parameters = declaration.parameters_json_schema
    if parameters is None and declaration.parameters is not None:
        parameters = _schema_json(declaration.parameters)
    return {
        "type": "function",
        "function": {
            "name": declaration.name,
            "description": declaration.description or "",
            "parameters": parameters or {"type": "object", "properties": {}},
        },
    }


def _system_text(instruction: Any) -> str:
    if instruction is None:
        return ""
    if isinstance(instruction, str):
        return instruction
    if isinstance(instruction, types.Content):
        return "\n".join(part.text or "" for part in instruction.parts or [])
    return str(instruction)


def request_to_messages(llm_request: LlmRequest) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Translate an ADK request into OpenAI-style messages and tools."""
    config = llm_request.config
    system = _system_text(config.system_instruction if config else None)
    schema = _schema_json(config.response_schema) if config else None
    if schema is None and config is not None and config.response_json_schema is not None:
        schema = _schema_json(config.response_json_schema)
    if schema is not None:
        system += (
            "\n\nReply with one JSON object only, no prose, matching this JSON schema:\n"
            + json.dumps(schema)
        )
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}] if system else []
    pending_ids: dict[str, list[str]] = {}
    for content in llm_request.contents:
        texts: list[str] = []
        calls: list[dict[str, Any]] = []
        for part in content.parts or []:
            if part.text:
                texts.append(part.text)
            elif part.function_call is not None:
                call_id = part.function_call.id or f"call_{uuid.uuid4().hex[:12]}"
                pending_ids.setdefault(part.function_call.name or "", []).append(call_id)
                calls.append(
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": part.function_call.name,
                            "arguments": json.dumps(part.function_call.args or {}),
                        },
                    }
                )
            elif part.function_response is not None:
                name = part.function_response.name or ""
                ids = pending_ids.get(name) or []
                call_id = part.function_response.id or (ids.pop(0) if ids else name)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": json.dumps(part.function_response.response or {}),
                    }
                )
        if content.role == "model":
            if texts or calls:
                message: dict[str, Any] = {"role": "assistant", "content": "\n".join(texts) or None}
                if calls:
                    message["tool_calls"] = calls
                messages.append(message)
        elif texts:
            messages.append({"role": "user", "content": "\n".join(texts)})
    tools = [
        _declaration_tool(declaration)
        for tool in (config.tools or [] if config else [])
        if isinstance(tool, types.Tool)
        for declaration in tool.function_declarations or []
    ]
    return messages, tools


def completion_to_response(data: dict[str, Any], *, structured: bool) -> LlmResponse:
    choices = data.get("choices") or []
    if not choices:
        raise NousError("Nous returned no choices.")
    message = choices[0].get("message") or {}
    parts: list[types.Part] = []
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        try:
            args = json.loads(function.get("arguments") or "{}")
        except json.JSONDecodeError as error:
            raise NousError("Nous returned malformed tool arguments.") from error
        part = types.Part.from_function_call(name=function.get("name", ""), args=args)
        part.function_call.id = call.get("id")
        parts.append(part)
    text = message.get("content") or ""
    if not parts:
        parts.append(types.Part(text=extract_json_text(text) if structured else text))
    usage = data.get("usage") or {}
    return LlmResponse(
        content=types.Content(role="model", parts=parts),
        usage_metadata=types.GenerateContentResponseUsageMetadata(
            prompt_token_count=usage.get("prompt_tokens", 0),
            candidates_token_count=usage.get("completion_tokens", 0),
            total_token_count=usage.get("total_tokens", 0),
        ),
    )


class NousLlm(BaseLlm):
    """ADK model backed by the Nous chat-completions API."""

    model: str = DEFAULT_MODEL
    api_key: str | None = None

    @property
    def capabilities(self) -> LlmCapabilities:
        # Like the offline fixture, take structured output through ADK's
        # set_model_response tool when an agent also has function tools.
        return LlmCapabilities(output_schema_and_tools=False)

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        messages, tools = request_to_messages(llm_request)
        structured = bool(llm_request.config and llm_request.config.response_schema) and not tools
        data = await chat_completion(
            messages, model=self.model, tools=tools, operation="agent", api_key=self.api_key
        )
        yield completion_to_response(data, structured=structured)


async def nous_complete(
    system: str, prompt: str, *, operation: str, json_mode: bool = False, temperature: float = 0.3
) -> str:
    data = await chat_completion(
        [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        model=nous_model(),
        temperature=temperature,
        operation=operation,
    )
    text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    return extract_json_text(text) if json_mode else text
