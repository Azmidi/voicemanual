# Manuel: voice assistant for the service manual (new version)

Manuel sits in the corner of the manual page. Click the mic once and just talk.

## What you can say

- Any question, for example "What does error 01/81 mean?" or "How do I remove the battery?"
- "Go to troubleshooting" (or any section name) to jump there
- "Scroll down", "Scroll up", "Go to top"
- "Read this page", "Repeat", "Stop", "Mute"
- After 15 quiet minutes Manuel rests. Say "Hey Manuel" to wake it.

You can also type a question in the box. Alt+M turns the mic on or off.

## Smarter answers with Gemini (optional)

1. Get a free key at https://aistudio.google.com/apikey
2. Click the gear icon in Manuel, paste the key, and press Save.

Without a key, Manuel still answers by searching the manual itself.
The key is stored only in that browser.

## For a whole team: no keys needed

If your organization runs the assistant server in the `proxy` folder, technicians
don't need a key at all. Point Manuel at the server in the script line:

```html
<script src="manuel/manuel.js" data-proxy="/api/ask"></script>
```

Setup steps for IT (company server or Cloudflare): [proxy/DEPLOY.md](../proxy/DEPLOY.md).
If the server can't be reached, Manuel uses a personal key if one is saved, and
otherwise searches the manual itself.

## Why this version won't break when Google retires a model

It doesn't use a fixed model name. It asks Google which models your key can use,
picks the newest stable "Flash" model, and picks again automatically if Google
says the model is gone. You can also choose a model yourself in settings.

## Adding it to a manual page

Put this line just before `</body>`:

```html
<script src="manuel/manuel.js"></script>
```

Voice listening works in Chrome and Edge. Other browsers can still use the typing box.
