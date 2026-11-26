# Voice Manual

The MOTOTRBO SL3500e / SL3500Max Basic Service Manual with **Manuel**, a hands-free voice assistant.

Open `index.html` in Chrome or Edge, click the round mic button in the bottom-right corner, and just ask.

- How to use Manuel, and how to add a free Gemini key for smarter answers: see [manuel/README.md](manuel/README.md)
- For many technicians: run the small assistant server in [proxy/](proxy/DEPLOY.md). It holds one key on the server (for your company's internal AI gateway, or Gemini) so nobody needs their own key. It can run on the same server as the manual.
- Manuel picks the Gemini model automatically, so it keeps working when Google retires old models.

To try it on your computer, serve the folder (for example `python3 -m http.server`) and open http://localhost:8000. The microphone only works on `localhost` or an `https://` address.
