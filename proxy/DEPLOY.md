# Manuel's assistant server: setup notes

## What this is, in one paragraph

Today each technician has to paste their own Gemini key into Manuel. This small
server holds **one** key for everyone instead. Manuel sends the question to the
server, the server asks Gemini, and the answer comes back. The key never reaches
anyone's browser. If the server can't be reached, Manuel still answers from its
built-in manual search, and anyone who saved a personal key can still use it.

The same code runs in two kinds of places, with no changes:

| Option | Good for | Cost |
|---|---|---|
| **A. Company server** (Node.js) | IT hosting the manual already. Manual and assistant on one server. | Your existing server |
| **B. Cloudflare Workers** | Trying it out quickly, or if there's no company server | Free tier covers 100,000 requests a day |

**Can it live on the same server as the manual?** Yes. That's option A, and it's
the simplest setup: one program serves both the manual pages and the assistant.

---

## Option A: on a company server (same server as the manual)

What IT needs: any server (Windows or Linux) with **Node.js 18 or newer**. No
other software or packages. This also works on Azure App Service, AWS (EC2,
Elastic Beanstalk, App Runner), or in Docker.

1. Copy the whole repository to the server (the manual plus this `proxy` folder).
2. In the `proxy` folder, copy `.env.example` to a new file named `.env`.
3. Open `.env` and paste the Gemini key after `GEMINI_API_KEY=`.
4. Start it: `node server.js` (run from inside the `proxy` folder).
5. Open `http://your-server:8787` and the manual appears.
6. Tell Manuel to use the server. In `index.html`, change the script line to:
   ```html
   <script src="manuel/manuel.js" data-proxy="/api/ask"></script>
   ```

That's it. Because the manual and the assistant are on the same address,
`ALLOWED_ORIGINS` can stay empty.

Tips for IT:
- To keep it running after a restart, use the usual tool: a Windows service
  (for example NSSM), `systemd` on Linux, or `pm2`.
- If it sits behind IIS, nginx, or a load balancer, set `TRUST_PROXY=true` so
  limits count each real user's address and not the load balancer's.
- If the manual is already hosted somewhere else (a doc portal), set
  `STATIC_DIR=` (empty) so this only runs the assistant, set
  `ALLOWED_ORIGINS=https://the-portal-address`, and use the full address in
  `data-proxy`, for example `data-proxy="https://assistant.company.com/api/ask"`.
- Docker: from the repository root, `docker build -f proxy/Dockerfile -t manuel .`
  then `docker run -p 8787:8787 -e GEMINI_API_KEY=... manuel`.

## Option B: on Cloudflare Workers

1. Make a free Cloudflare account, and install Node.js on your own computer.
2. In the `proxy` folder, run `npx wrangler login`.
3. Open `wrangler.toml` and set `ALLOWED_ORIGINS` to the address where the
   manual is published (for example `https://azmidi.github.io`).
4. Store the key as a secret: `npx wrangler secret put GEMINI_API_KEY`, then paste it.
5. Publish: `npx wrangler deploy`. It prints an address like
   `https://manuel-proxy.your-name.workers.dev`.
6. In `index.html`:
   ```html
   <script src="manuel/manuel.js" data-proxy="https://manuel-proxy.your-name.workers.dev/api/ask"></script>
   ```

---

## Checking that it works

Open `<server address>/api/health` in a browser. You should see
`{"ok":true,"provider":"gemini","configured":true}`. It never shows the key.
Then ask Manuel a question. In the settings panel it now says the answers come
from your organization's server.

## All settings

| Setting | What it does | Default |
|---|---|---|
| `GEMINI_API_KEY` | The one shared Gemini key. Keep it secret. | (none) |
| `GEMINI_MODEL` | Always use this model. Leave empty to choose automatically, as Manuel does today. | automatic |
| `AI_PROVIDER` | `gemini`, or `azure-openai` if the company approves that instead | `gemini` |
| `ALLOWED_ORIGINS` | Websites allowed to use the server, comma separated. Empty = only pages on this same server. | empty |
| `RATE_LIMIT_PER_MINUTE` | Questions per network address per minute | 30 |
| `RATE_LIMIT_PER_DAY` | Questions per network address per day | 1000 |
| `MAX_BODY_BYTES` | Biggest request accepted (the manual is sent along, about 85 KB) | 2,000,000 |
| `STATIC_DIR` | Folder of the manual to serve too (company server only) | (none) |
| `PORT`, `HOST`, `TRUST_PROXY` | Company server only | 8787, all, false |

### About the limits
Many technicians in one office often share **one** internet address, so the
limits count the whole office together. 30 a minute and 1000 a day suit a busy
site. Raise them if people see "Lots of questions right now". On Cloudflare the
count is kept per Cloudflare location, so it's a speed bump, not a hard cap. For
a strict cap there, add a Cloudflare rate limiting rule as well.

### About the allowed websites check
It stops other websites from using your key through people's browsers. It does
not stop someone who writes their own program. For a manual used inside the
company, the stronger protection is to put the server on the company network or
behind the company sign-in (for example Cloudflare Access, or the portal's own
login). Also set a monthly spending limit on the Gemini key in Google Cloud.

## Switching AI provider later

Only the files in `src/providers/` talk to an AI service. Everything else
(limits, checks, Manuel itself) stays the same. To use Azure OpenAI, set
`AI_PROVIDER=azure-openai` plus `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`
and `AZURE_OPENAI_DEPLOYMENT`. That provider is written and tested with a
simulated Azure reply, but hasn't been tried on a real Azure account yet, so
test it once before switching everyone over. Another provider means adding one
file in `src/providers/`.

## For developers

- `src/core.js` is the shared logic, using only web-standard `Request`/`Response`.
- `src/worker.js` (Cloudflare) and `server.js` (Node) are thin wrappers around it.
- Tests: `npm test` (no packages to install).
