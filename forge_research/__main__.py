import argparse
import asyncio
import os
import sys

from google.adk.agents.invocation_context import LlmCallsLimitExceededError
from google.genai.errors import APIError

from .catalog import ResearchError
from .offline import DEMO_BRIEF, DemoModel
from .workflow import run_research


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the FORGE component research swarm.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--offline", action="store_true", help="Run the scripted wristband fixture."
    )
    source.add_argument("--brief", help="Send a device brief to the live Gemini workflow.")
    args = parser.parse_args()

    if args.offline:
        brief, model, mode = DEMO_BRIEF, DemoModel(), "offline"
    else:
        brief, model, mode = args.brief, os.getenv("FORGE_GEMINI_MODEL", "").strip(), "gemini"
        if not model.startswith("gemini-"):
            parser.error(
                "Set FORGE_GEMINI_MODEL to the Gemini model ID enabled for your account."
            )
        if not (os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")):
            parser.error("Set GEMINI_API_KEY or GOOGLE_API_KEY for live Gemini runs.")
        os.environ["GOOGLE_GENAI_USE_ENTERPRISE"] = "false"
        os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "false"

    try:
        report = asyncio.run(run_research(brief, model, mode=mode))
    except ResearchError as error:
        print(f"FORGE research failed. {error}", file=sys.stderr)
        return 1
    except APIError as error:
        print(f"Gemini request failed (API status {error.code}).", file=sys.stderr)
        return 1
    except (TimeoutError, LlmCallsLimitExceededError):
        print(
            "FORGE research exceeded its workflow time or model call limit.", file=sys.stderr
        )
        return 1
    print(report.model_dump_json(indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
