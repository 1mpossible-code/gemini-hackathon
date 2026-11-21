from google.adk.models import BaseLlm, LlmCapabilities, LlmRequest, LlmResponse
from google.genai import types

from .models import Proposal, Requirements, ReviewNotes

DEMO_BRIEF = (
    "Design a wrist-worn finger-gesture detector using muscle sensors for under $100 "
    "that sends gesture events to my laptop over Bluetooth Low Energy."
)


class DemoModel(BaseLlm):
    """Exercise the ADK workflow with scripted responses and real catalog tool calls."""

    model: str = "offline-wristband-fixture"

    @property
    def capabilities(self) -> LlmCapabilities:
        return LlmCapabilities(output_schema_and_tools=False)

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False):
        instruction = llm_request.config.system_instruction
        usage = types.GenerateContentResponseUsageMetadata(
            prompt_token_count=0, candidates_token_count=0, total_token_count=0
        )
        if instruction.startswith("Extract hardware requirements"):
            response = Requirements(
                application="emg_wearable",
                budget_usd_cents=10_000,
                budget_exclusive=True,
                transport="ble",
                wrist_circumference_mm=None,
                gestures=["individual finger gestures"],
                unresolved=["Wrist circumference and target finger gestures are unspecified."],
            )
        elif instruction.startswith("Select a controller"):
            looked_up = any(
                part.function_response is not None
                and part.function_response.name == "lookup_parts"
                for content in llm_request.contents
                for part in content.parts or []
            )
            if not looked_up:
                yield LlmResponse(
                    content=types.Content(
                        role="model",
                        parts=[
                            types.Part.from_function_call(
                                name="lookup_parts", args={"role": role}
                            )
                            for role in ("controller", "emg_sensor")
                        ],
                    ),
                    usage_metadata=usage,
                )
                return
            response = Proposal(
                controller_id="esp32-devkitc-32e",
                sensor_id="myoware-2-dev-27924",
                rationale="The ESP32 has onboard BLE and ADC inputs. The UNO lacks onboard BLE.",
            )
        elif instruction.startswith("Read the requirements"):
            response = ReviewNotes(
                next_steps=[
                    "Confirm the input conditioning and build a synthetic idle/flex firmware fixture.",
                    "Price electrodes, power, and enclosure before judging the full budget.",
                    "Validate BLE and individual-finger accuracy on hardware.",
                ]
            )
        else:
            raise ValueError("Unexpected agent instruction in the offline fixture.")

        part = (
            types.Part.from_function_call(
                name="set_model_response", args=response.model_dump(mode="json")
            )
            if isinstance(response, Proposal)
            else types.Part(text=response.model_dump_json())
        )
        yield LlmResponse(
            content=types.Content(role="model", parts=[part]),
            usage_metadata=usage,
        )
