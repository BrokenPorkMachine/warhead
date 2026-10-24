"""Warhead's API-v2 Studio entrypoint. Node runs the bundled Warhead engine."""
import json
from pathlib import Path
import shutil
import subprocess
from hindsight import api as studio

TITLE = "Warhead: MGCA (Military Grade Coding Agent)"
settings = studio.settings
state = studio.state
result = {"name": TITLE, "mode": "reviewable code proposals", "live_control": False}

if studio.event == "command.run":
    model = str(settings.get("model") or "").strip()
    prompt = str(settings.get("task") or "").strip()
    node = shutil.which("node")
    runtime = Path(__file__).resolve().parent / "runtime" / "cli" / "extension.js"
    if not model or not prompt:
        result.update(ok=False, error="Set model and task in Warhead extension settings. Use the CLI's discovery picker to find models across surfaces.")
    elif not node or not runtime.is_file():
        result.update(ok=False, error="Warhead needs Node.js >=20 and its bundled runtime. Check the HindSight package installation.")
    else:
        request = {"host": settings.get("host") or "http://localhost:11434", "model": model,
                   "prompt": prompt, "snapshot": {"selection": studio.selection, "analysis": studio.analysis}}
        payload = json.dumps(request, ensure_ascii=False)
        if len(payload.encode("utf-8")) > 256 * 1024:
            result.update(ok=False, error="Studio context exceeds 256 KiB. Narrow the current analysis before running Warhead.")
        else:
            try:
                process = subprocess.run([node, str(runtime)], input=payload, text=True,
                                         capture_output=True, timeout=24, check=False)
                if len(process.stdout.encode("utf-8")) > 384 * 1024:
                    raise ValueError("Warhead response exceeded the output budget")
                reply = json.loads(process.stdout)
                if not isinstance(reply, dict):
                    raise ValueError("Warhead returned an invalid response")
                result.update(reply)
                if process.returncode:
                    result["ok"] = False
            except (subprocess.TimeoutExpired, OSError, ValueError) as error:
                result.update(ok=False, error=str(error)[:1000])
    # Never frame model output as host actions or script result markers.
    studio.state_set("last_result", json.dumps(result, ensure_ascii=False)[:56000])
elif studio.event == "command.clear":
    studio.state_set("last_result", "")
    result["message"] = "Last Warhead result cleared."
else:
    previous = state.get("last_result")
    if previous:
        try:
            result = json.loads(previous)
        except ValueError:
            result["message"] = "Previous result was truncated; run a narrower task."
    else:
        result["message"] = "Set host, model, and task in extension settings, then run Warhead. Code proposals are reviewed here; use warhead-cli to apply edits with approvals."
# Print JSON, not raw model text: embedded host delimiters stay inside an encoded string.
print(json.dumps(result, ensure_ascii=False))
