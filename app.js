/* Beam — serverless P2P file sharing over a WebRTC data channel.
   Signaling is manual: the two peers exchange offer/reply codes by any channel they like. */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const CHUNK = 16 * 1024;
  const BUF_MAX = 512 * 1024;
  const BUF_LOW = 128 * 1024;
  const ICE_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  const EOF = "__beam_eof__";

  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  };

  let toastTimer;
  const toast = (msg) => {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.hidden = true;
    }, 2400);
  };

  const setStatus = (id, msg, kind) => {
    const n = $(id);
    n.textContent = msg;
    n.className = "status" + (kind ? ` ${kind}` : "");
  };

  /* ---------- code encode/decode ---------- */
  const encodeDesc = (desc) => btoa(JSON.stringify({ t: desc.type, s: desc.sdp }));
  const decodeCode = (text) => {
    const raw = JSON.parse(atob(text.trim()));
    if (raw.t !== "offer" && raw.t !== "answer") throw new Error("not a Beam code");
    return { type: raw.t, sdp: raw.s };
  };

  const gathered = (pc) =>
    new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const timer = setTimeout(done, 2500);
      function done() {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
      function check() {
        if (pc.iceGatheringState === "complete") done();
      }
      pc.addEventListener("icegatheringstatechange", check);
    });

  const bufferedLow = (dc) =>
    new Promise((resolve) => {
      dc.addEventListener("bufferedamountlow", resolve, { once: true });
    });

  /* ---------- shared reset ---------- */
  const show = (...stepIds) => {
    for (const id of stepIds) $(id).hidden = false;
  };
  const hideAll = (...stepIds) => {
    for (const id of stepIds) $(id).hidden = true;
  };

  /* ================= SENDER ================= */
  let sendFile = null;
  let sendPc = null;
  let sendDc = null;
  let sendStart = 0;
  let sendDone = false;

  const dropzone = $("#dropzone");
  const fileInput = $("#file-input");

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-over");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, () => dropzone.classList.remove("is-over"))
  );
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) pickFile(f);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) pickFile(fileInput.files[0]);
  });

  const pickFile = (f) => {
    sendFile = f;
    const p = $("#picked");
    p.textContent = "";
    p.append(el("span", null, f.name), el("span", "sz", fmtBytes(f.size)));
    p.hidden = false;
    $("#make-offer").disabled = false;
  };

  $("#make-offer").addEventListener("click", async () => {
    if (!sendFile) return;
    try {
      setStatus("#s2-status", "Creating invite…");
      sendPc = new RTCPeerConnection(ICE_CONFIG);
      sendDc = sendPc.createDataChannel("beam", { ordered: true });
      sendDc.bufferedAmountLowThreshold = BUF_LOW;
      sendDc.onopen = () => startSending();
      sendDc.onerror = () => {
        if (!sendDone) setStatus("#s3-status", "Connection error — try again.", "err");
      };
      const offer = await sendPc.createOffer();
      await sendPc.setLocalDescription(offer);
      await gathered(sendPc);
      $("#offer-box").value = encodeDesc(sendPc.localDescription);
      hideAll("#s1");
      show("#s2");
      setStatus("#s2-status", "Invite ready. It stays valid until you cancel.");
    } catch (err) {
      setStatus("#s2-status", "Could not create the invite — " + (err && err.message ? err.message : "check your connection."), "err");
    }
  });

  $("#copy-offer").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#offer-box").value);
      toast("Invite copied");
    } catch {
      $("#offer-box").select();
      toast("Press Ctrl+C to copy");
    }
  });

  $("#accept-answer").addEventListener("click", async () => {
    const raw = $("#answer-in").value;
    if (!raw.trim()) {
      setStatus("#s2-status", "Paste the reply code first.", "err");
      return;
    }
    try {
      setStatus("#s2-status", "Connecting…");
      await sendPc.setRemoteDescription(decodeCode(raw));
      hideAll("#s2");
      show("#s3");
      $("#send-file-name").textContent = `${sendFile.name} · ${fmtBytes(sendFile.size)}`;
      $("#s3-cancel").hidden = false;
      $("#send-again").hidden = true;
      setStatus("#s3-status", "Handshake complete — waiting for the channel to open…");
    } catch {
      setStatus("#s2-status", "That reply code doesn't look right. Copy it again from your friend.", "err");
    }
  });

  const startSending = async () => {
    sendStart = Date.now();
    setStatus("#s3-status", "Sending…");
    let sent = 0;
    let lastTick = sendStart;
    let lastBytes = 0;

    try {
      sendDc.send(
        JSON.stringify({ name: sendFile.name, size: sendFile.size, type: sendFile.type || "application/octet-stream" })
      );
      while (sent < sendFile.size) {
        if (sendDc.readyState !== "open") throw new Error("channel closed");
        if (sendDc.bufferedAmount > BUF_MAX) {
          await bufferedLow(sendDc);
          continue;
        }
        const buf = await sendFile.slice(sent, sent + CHUNK).arrayBuffer();
        sendDc.send(buf);
        sent += buf.byteLength;
        const pct = Math.floor((sent / sendFile.size) * 100);
        $("#send-bar").style.width = `${pct}%`;
        $("#send-pct").textContent = `${pct}%`;
        const now = Date.now();
        if (now - lastTick >= 500) {
          const speed = ((sent - lastBytes) * 1000) / (now - lastTick);
          $("#send-speed").textContent = `${fmtBytes(speed)}/s`;
          lastTick = now;
          lastBytes = sent;
        }
      }
      sendDc.send(EOF);
      sendDone = true;
      setStatus("#s3-status", "Sent ✓ Your friend has the file.", "ok");
      $("#s3-cancel").hidden = true;
      $("#send-again").hidden = false;
    } catch {
      setStatus("#s3-status", "Transfer failed — the connection dropped.", "err");
      $("#s3-cancel").hidden = true;
      $("#send-again").hidden = false;
    }
  };

  const teardownSend = () => {
    if (sendDc) {
      sendDc.onopen = null;
      sendDc.onerror = null;
    }
    if (sendPc) sendPc.close();
    sendPc = null;
    sendDc = null;
  };

  const resetSender = () => {
    teardownSend();
    sendFile = null;
    sendDone = false;
    fileInput.value = "";
    $("#picked").hidden = true;
    $("#make-offer").disabled = true;
    $("#offer-box").value = "";
    $("#answer-in").value = "";
    $("#send-bar").style.width = "0%";
    $("#send-pct").textContent = "0%";
    $("#send-speed").textContent = "";
    setStatus("#s2-status", "");
    setStatus("#s3-status", "");
    hideAll("#s2", "#s3");
    show("#s1");
  };

  $("#s2-cancel").addEventListener("click", resetSender);
  $("#s3-cancel").addEventListener("click", resetSender);
  $("#send-again").addEventListener("click", resetSender);

  /* ================= RECEIVER ================= */
  let recvPc = null;
  let recvDc = null;
  let recvMeta = null;
  let recvChunks = [];
  let recvBytes = 0;
  let recvStart = 0;
  let recvLastTick = 0;
  let recvLastBytes = 0;
  let recvBlobUrl = null;
  let recvDone = false;

  $("#join").addEventListener("click", async () => {
    const raw = $("#offer-in").value;
    if (!raw.trim()) {
      setStatus("#r1-status", "Paste an invite code first.", "err");
      return;
    }
    try {
      const offer = decodeCode(raw);
      setStatus("#r1-status", "Preparing reply…");
      recvPc = new RTCPeerConnection(ICE_CONFIG);
      recvPc.ondatachannel = (e) => {
        recvDc = e.channel;
        recvDc.onmessage = onRecvMessage;
        recvDc.onerror = () => {
          if (!recvDone) setStatus("#r3-status", "Connection error — ask for a new invite.", "err");
        };
      };
      await recvPc.setRemoteDescription(offer);
      const answer = await recvPc.createAnswer();
      await recvPc.setLocalDescription(answer);
      await gathered(recvPc);
      $("#answer-box").value = encodeDesc(recvPc.localDescription);
      hideAll("#r1");
      show("#r2");
    } catch {
      setStatus("#r1-status", "That invite code doesn't look right — copy it again.", "err");
    }
  });

  $("#copy-answer").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#answer-box").value);
      toast("Reply copied");
    } catch {
      $("#answer-box").select();
      toast("Press Ctrl+C to copy");
    }
  });

  const onRecvMessage = (e) => {
    const data = e.data;
    if (typeof data === "string") {
      if (data === EOF) finishReceive();
      else {
        try {
          recvMeta = JSON.parse(data);
        } catch {
          return;
        }
        recvChunks = [];
        recvBytes = 0;
        recvStart = Date.now();
        recvLastTick = recvStart;
        recvLastBytes = 0;
        hideAll("#r2");
        show("#r3");
        $("#recv-file-name").textContent = `${recvMeta.name} · ${fmtBytes(recvMeta.size)}`;
        $("#save-file").hidden = true;
        $("#recv-again").hidden = true;
        $("#r3-status").textContent = "Receiving…";
        $("#r3-status").className = "status";
      }
      return;
    }
    recvChunks.push(data);
    recvBytes += data.byteLength || data.size || 0;
    const pct = recvMeta ? Math.min(100, Math.floor((recvBytes / recvMeta.size) * 100)) : 0;
    $("#recv-bar").style.width = `${pct}%`;
    $("#recv-pct").textContent = `${pct}%`;
    const now = Date.now();
    if (now - recvLastTick >= 500) {
      const speed = ((recvBytes - recvLastBytes) * 1000) / (now - recvLastTick);
      $("#recv-speed").textContent = `${fmtBytes(speed)}/s`;
      recvLastTick = now;
      recvLastBytes = recvBytes;
    }
  };

  const finishReceive = () => {
    if (recvDone) return;
    recvDone = true;
    const blob = new Blob(recvChunks, { type: recvMeta?.type || "application/octet-stream" });
    if (recvBlobUrl) URL.revokeObjectURL(recvBlobUrl);
    recvBlobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = recvBlobUrl;
    a.download = recvMeta?.name || "beam-file";
    document.body.append(a);
    a.click();
    a.remove();
    $("#save-file").hidden = false;
    $("#recv-again").hidden = false;
    $("#save-file").onclick = () => {
      const b = document.createElement("a");
      b.href = recvBlobUrl;
      b.download = recvMeta?.name || "beam-file";
      document.body.append(b);
      b.click();
      b.remove();
    };
    const secs = Math.max(0.1, (Date.now() - recvStart) / 1000);
    $("#recv-bar").style.width = "100%";
    $("#recv-pct").textContent = "100%";
    $("#recv-speed").textContent = `${fmtBytes(recvMeta.size / secs)}/s avg`;
    $("#r3-status").textContent = "Received ✓ Check your downloads.";
    $("#r3-status").className = "status ok";
  };

  const resetReceiver = () => {
    if (recvDc) {
      recvDc.onmessage = null;
      recvDc.onerror = null;
    }
    if (recvPc) recvPc.close();
    recvPc = null;
    recvDc = null;
    recvMeta = null;
    recvChunks = [];
    recvBytes = 0;
    recvDone = false;
    $("#offer-in").value = "";
    $("#answer-box").value = "";
    $("#recv-bar").style.width = "0%";
    $("#recv-pct").textContent = "0%";
    $("#recv-speed").textContent = "";
    setStatus("#r1-status", "");
    $("#r3-status").textContent = "";
    $("#r3-status").className = "status";
    hideAll("#r2", "#r3");
    show("#r1");
  };

  $("#recv-again").addEventListener("click", resetReceiver);

  window.addEventListener("beforeunload", () => {
    teardownSend();
    if (recvPc) recvPc.close();
  });
})();
