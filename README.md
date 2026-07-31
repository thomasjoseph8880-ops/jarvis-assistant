# J.A.R.V.I.S — local voice assistant

Flask backend + Gemini function calling + Web Speech API front end.

## Run it locally (required for "open app" to work)

```bash
cd jarvis-assistant
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env          # then edit .env and paste your real GEMINI_API_KEY
python app.py
```

Open **http://localhost:5000** in **Chrome or Edge** (Web Speech API doesn't
work in Firefox/Safari yet). Allow microphone access when prompted — it starts
listening automatically, no button to click.

## Always-listening mode

Jarvis listens continuously in the background, but only reacts to speech that
**starts with the wake word "Jarvis"** — e.g. "Jarvis, what time is it."
Anything said without that wake word is ignored, which stops random room
noise or conversation from triggering it (and racking up Gemini API calls).

The mic automatically pauses while Jarvis is speaking its reply, so it never
hears — and reacts to — its own voice.

## Try it

- "What time is it?"
- "Open chrome"
- "Open youtube.com"

## Adding more apps

Edit `APP_COMMANDS` in `app.py` — add an entry per OS with the shell command
that launches the app on your machine.

## Deploying to Railway

`Procfile` is included:

```
web: gunicorn app:app
```

Set `GEMINI_API_KEY` as an environment variable in Railway's dashboard
(never commit `.env`). Here's what still works and what doesn't once deployed:

| Feature | On Railway |
|---|---|
| Voice in/out, chat replies | Works — runs in the user's browser and via HTTPS to Gemini |
| "Open youtube.com" | Works — the backend tells the browser to open it (`window.open`), so it always happens on the user's device |
| "Open chrome" / "open notepad" | **Doesn't work** — Railway's container has no desktop. The app detects this (`RAILWAY_ENVIRONMENT`) and replies explaining it instead of failing silently. Native app launching only works when `app.py` runs on your own computer |
