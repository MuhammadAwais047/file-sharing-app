# Beam — serverless P2P file sharing 📡

Send a file **straight to one person** over an encrypted WebRTC data channel. No server stores the file, no account, no link — just two browsers and a pair of codes.

**Live demo:** https://muhammadawais047.github.io/file-sharing-app/

## How it works

1. **Sender** picks (or drops) a file and gets an **invite code** — an SDP description of their browser's network route.
2. **Receiver** pastes the invite, gets a **reply code**, sends it back.
3. Sender pastes the reply → the browsers connect **directly** and the file streams across in 16 KB chunks with live progress and speed.

There is no signaling server: the codes are the signaling. You can carry them however you like — chat, email, or read them aloud if you're patient.

## Features

- Real **WebRTC RTCPeerConnection + RTCDataChannel** — encrypted (DTLS) by the browser, end to end
- **Drag & drop** or file picker
- Chunked transfer (16 KB) with **backpressure** (`bufferedAmount` + `bufferedamountlow`) so even large files don't blow up memory
- Live **progress bar + transfer speed** on both sides
- Receiver gets the file **auto-downloaded**, with a "save again" button
- Invite/reply codes are **base64 SDP**, copy buttons included
- Cancel / send-another / receive-another flows, ICE-gathering timeout so codes generate fast
- Honest about limits: if no direct route exists, the connection fails instead of silently relaying through a server

## Limits (by design)

- Both peers must be online at the same time
- Some strict corporate NATs won't allow a direct connection (no TURN relay here — on purpose: nothing intermediates your file)
- One file per session; use "Send another" for the next one

## Tech

- One `index.html` + `styles.css` + `app.js` (~400 lines of JS, zero dependencies, zero servers)
- All DOM writes via `createElement` / `textContent` (XSS-safe)

## Run locally

```bash
python -m http.server 8080
# then open http://localhost:8080 in two tabs/windows and beam a file to yourself
```

(Any static server works. Two tabs on the same machine make a great demo.)

---

Built by [Muhammad Awais](https://github.com/MuhammadAwais047) as portfolio project #17.
