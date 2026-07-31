"""
J.A.R.V.I.S. — local voice assistant backend
Flask + Gemini API (function calling) + local OS command execution.

Run locally (not on a cloud host) if you want "open app" to actually work,
since it opens apps on whatever machine this process runs on.
"""

import os
import platform
import subprocess
from datetime import datetime

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

load_dotenv()

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
# gemini-2.5-flash is being retired (Oct 2026) — use the current GA flash model.
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)

app = Flask(__name__)

# ---------------------------------------------------------------------------
# App name -> launch command map. Extend this with whatever you use.
# Add more entries as needed; keys should be lowercase.
# ---------------------------------------------------------------------------
APP_COMMANDS = {
    "windows": {
        "chrome": "start chrome",
        "notepad": "start notepad",
        "calculator": "start calc",
        "file explorer": "start explorer",
        "vs code": "start code",
        "spotify": "start spotify",
    },
    "darwin": {  # macOS
        "chrome": "open -a 'Google Chrome'",
        "notepad": "open -a TextEdit",
        "calculator": "open -a Calculator",
        "file explorer": "open .",
        "vs code": "open -a 'Visual Studio Code'",
        "spotify": "open -a Spotify",
    },
    "linux": {
        "chrome": "google-chrome",
        "notepad": "gedit",
        "calculator": "gnome-calculator",
        "file explorer": "nautilus .",
        "vs code": "code",
        "spotify": "spotify",
    },
}

# ---------------------------------------------------------------------------
# Tool (function) definitions handed to Gemini
# ---------------------------------------------------------------------------
TOOLS = [
    {
        "function_declarations": [
            {
                "name": "open_app",
                "description": "Open a desktop application on the user's computer.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "app_name": {
                            "type": "string",
                            "description": "Name of the app, e.g. 'chrome', 'notepad', 'spotify', 'vs code'.",
                        }
                    },
                    "required": ["app_name"],
                },
            },
            {
                "name": "open_website",
                "description": "Open a website in the default browser.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "Full URL, e.g. https://youtube.com",
                        }
                    },
                    "required": ["url"],
                },
            },
            {
                "name": "get_time",
                "description": "Get the current date and time.",
                "parameters": {"type": "object", "properties": {}},
            },
        ]
    }
]

SYSTEM_INSTRUCTION = (
    "You are JARVIS, a concise, helpful voice assistant. Keep spoken replies "
    "short (1-2 sentences) since they'll be read aloud by text-to-speech. "
    "Use the available tools when the user asks to open an app or website, "
    "or asks for the time. Otherwise, just answer directly."
)


# ---------------------------------------------------------------------------
# Tool execution (runs on THIS machine)
# ---------------------------------------------------------------------------
# If this env var is set (Railway sets it automatically), we're running on
# a remote server with no desktop attached — native app launching is
# physically impossible there, so we say so instead of silently failing.
IS_CLOUD = bool(os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("DYNO"))


def execute_open_app(app_name: str) -> dict:
    if IS_CLOUD:
        return {
            "reply": f"I can't open {app_name} — this server is running in the "
                     f"cloud with no desktop attached. Run app.py on your own "
                     f"computer for app launching to work."
        }

    system = platform.system().lower()
    if "windows" in system:
        commands = APP_COMMANDS["windows"]
    elif "darwin" in system:
        commands = APP_COMMANDS["darwin"]
    else:
        commands = APP_COMMANDS["linux"]

    key = app_name.strip().lower()
    cmd = commands.get(key)
    if not cmd:
        return {"reply": f"I don't have a launch command for '{app_name}' yet. Add it to APP_COMMANDS in app.py."}

    try:
        subprocess.Popen(cmd, shell=True)
        return {"reply": f"Opening {app_name}."}
    except Exception as exc:  # noqa: BLE001
        app.logger.error("Failed to open app '%s': %s", app_name, exc)
        return {"reply": f"Something went wrong trying to open {app_name}."}


def execute_open_website(url: str) -> dict:
    if not url.startswith("http"):
        url = "https://" + url
    # Always hand this back to the browser to open — works identically
    # whether the backend is running on localhost or on Railway.
    return {"reply": f"Opening {url}.", "action": {"type": "open_url", "url": url}}


def execute_get_time() -> dict:
    return {"reply": f"It's currently {datetime.now().strftime('%I:%M %p on %B %d, %Y')}."}


TOOL_DISPATCH = {
    "open_app": lambda args: execute_open_app(args.get("app_name", "")),
    "open_website": lambda args: execute_open_website(args.get("url", "")),
    "get_time": lambda args: execute_get_time(),
}


# ---------------------------------------------------------------------------
# Gemini call
# ---------------------------------------------------------------------------
def call_gemini(user_text: str) -> dict:
    if not GEMINI_API_KEY:
        return {"reply": "Server isn't configured with a GEMINI_API_KEY yet. Add one to your .env file."}

    payload = {
        "system_instruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "tools": TOOLS,
    }
    headers = {"Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY}

    try:
        resp = requests.post(GEMINI_URL, json=payload, headers=headers, timeout=20)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as exc:
        # Log the real error server-side only — never echo raw exception
        # details (which can include response bodies/URLs) back to the client.
        app.logger.error("Gemini request failed: %s", exc)
        return {"reply": "I couldn't reach Gemini right now. Please try again in a moment."}

    try:
        parts = data["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError):
        return {"reply": "I got an unexpected response from Gemini."}

    for part in parts:
        if "functionCall" in part:
            fn_name = part["functionCall"]["name"]
            fn_args = part["functionCall"].get("args", {})
            handler = TOOL_DISPATCH.get(fn_name)
            if handler:
                return handler(fn_args)
            return {"reply": f"I tried to call an unknown tool: {fn_name}"}

    text_reply = "".join(p.get("text", "") for p in parts).strip()
    return {"reply": text_reply or "I didn't catch that — could you say it again?"}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/command", methods=["POST"])
def command():
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        return jsonify({"reply": "I didn't hear anything."}), 400

    result = call_gemini(text)
    return jsonify(result)


@app.errorhandler(Exception)
def handle_unexpected_error(exc):
    from werkzeug.exceptions import HTTPException

    # Ordinary HTTP errors (404 Not Found, 405 Method Not Allowed, etc.) are
    # normal and expected — e.g. the browser auto-requesting /favicon.ico.
    # Let Flask handle those as usual; only log+mask genuine crashes.
    if isinstance(exc, HTTPException):
        return exc

    app.logger.error("Unhandled error: %s", exc, exc_info=True)
    return jsonify({"reply": "Something went wrong on the server."}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    # Debug mode is OFF unless you explicitly opt in for local development.
    # Never enable it when deployed — Flask's debugger can expose secrets
    # (like GEMINI_API_KEY) from the environment if a request errors out.
    debug_mode = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug_mode)
