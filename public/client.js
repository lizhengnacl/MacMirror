const screen = document.querySelector("#screen");
const statusEl = document.querySelector("#status");
const statusText = document.querySelector("#statusText");
const qualitySelect = document.querySelector("#quality");
const modeButton = document.querySelector("#modeButton");
const orientationButton = document.querySelector("#orientationButton");
const monitorBadge = document.querySelector("#monitorBadge");
const ownership = document.querySelector("#ownership");
const signalPanel = document.querySelector("#signalPanel");
const signalTitle = document.querySelector("#signalTitle");
const signalBody = document.querySelector("#signalBody");

let socket = null;
let peer = null;
let inputChannel = null;
let reconnectTimer = null;
let reconnectDelay = 500;
let signalTimer = null;
let orientationMessageTimer = null;
let connected = false;
let canControl = false;
let monitorMode = false;
let landscapeSessionActive = false;
let orientationLockActive = false;
let currentQuality = qualitySelect.value;
let currentOfferId = 0;
let webRtcState = "new";
let iceState = "new";
let dataChannelState = "connecting";
let frameMeta = null;
let firstFrameReceived = false;
let connectedAt = 0;
let viewScale = 1;
let gesture = null;
let longPressTimer = null;
let rightClickSent = false;
let lastMoveSentAt = 0;
let captureStatus = {
  state: "starting",
  message: "Connecting to the macOS capture helper.",
  hasFrame: false,
  blankFrame: false
};

function setStatus(state, label) {
  statusEl.classList.remove("connected", "disconnected", "warning");
  statusEl.classList.add(state);
  statusText.textContent = label;
}

function setMonitorMode(enabled) {
  monitorMode = enabled;
  modeButton.setAttribute("aria-pressed", String(enabled));
  modeButton.textContent = enabled ? "Monitor" : "Operate";
  monitorBadge.hidden = !enabled;
}

function updateOwnership() {
  ownership.hidden = canControl || !connected;
}

function setSignal(title, body) {
  signalTitle.textContent = title;
  signalBody.textContent = body;
  signalPanel.hidden = false;
}

function hideSignal() {
  signalPanel.hidden = true;
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

async function requestDocumentFullscreen() {
  const target = document.documentElement;
  const request = target.requestFullscreen || target.webkitRequestFullscreen;
  if (!request || fullscreenElement()) {
    return false;
  }

  try {
    if (request === target.requestFullscreen) {
      await request.call(target, { navigationUI: "hide" });
    } else {
      await request.call(target);
    }
    return true;
  } catch {
    return false;
  }
}

async function exitDocumentFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit || !fullscreenElement()) {
    return false;
  }

  try {
    await exit.call(document);
    return true;
  } catch {
    return false;
  }
}

async function lockLandscape() {
  const orientation = window.screen?.orientation;
  if (!orientation?.lock) {
    return false;
  }

  try {
    await orientation.lock("landscape");
    orientationLockActive = true;
    return true;
  } catch {
    return false;
  }
}

function unlockLandscape() {
  const orientation = window.screen?.orientation;
  if (orientationLockActive && orientation?.unlock) {
    try {
      orientation.unlock();
    } catch {
      // Some browsers unlock automatically when fullscreen closes.
    }
  }
  orientationLockActive = false;
}

function updateOrientationButton() {
  const active = landscapeSessionActive || orientationLockActive || Boolean(fullscreenElement());
  orientationButton.setAttribute("aria-pressed", String(active));
  orientationButton.setAttribute("aria-label", active ? "Exit landscape" : "Enter landscape");
  orientationButton.title = active ? "Exit landscape" : "Enter landscape";
}

function showLandscapeFallback() {
  setSignal("Rotate device", "Turn your phone sideways for the widest view.");
  window.clearTimeout(orientationMessageTimer);
  orientationMessageTimer = window.setTimeout(updateSignal, 2200);
}

async function enterLandscape() {
  const fullscreenChanged = await requestDocumentFullscreen();
  const lockChanged = await lockLandscape();
  landscapeSessionActive = fullscreenChanged || lockChanged;

  if (!landscapeSessionActive && !window.matchMedia("(orientation: landscape)").matches) {
    showLandscapeFallback();
  }

  updateOrientationButton();
  updateScreenTransform();
  window.setTimeout(updateScreenTransform, 120);
}

async function exitLandscape() {
  unlockLandscape();
  await exitDocumentFullscreen();
  landscapeSessionActive = false;
  updateOrientationButton();
  updateScreenTransform();
}

function handleFullscreenChange() {
  if (!fullscreenElement()) {
    landscapeSessionActive = false;
    orientationLockActive = false;
  }
  updateOrientationButton();
  updateScreenTransform();
}

function permissionBody(message) {
  return message || "Grant Screen Recording permission to the terminal app that started MacMirror, then restart the service.";
}

function updateSignal() {
  if (!connected) {
    setSignal("Connection lost", "Trying to reconnect to the MacMirror service.");
    return;
  }

  if (captureStatus.state === "disabled") {
    setStatus("warning", "Capture disabled");
    setSignal("Capture disabled", captureStatus.message);
    return;
  }

  if (captureStatus.state === "error" || captureStatus.state === "stopped") {
    setStatus("warning", "Capture stopped");
    setSignal("Capture stopped", captureStatus.message || "Restart MacMirror and check the terminal output.");
    return;
  }

  if (captureStatus.blankFrame) {
    setStatus("warning", "Black screen");
    setSignal("Captured black frames", permissionBody(captureStatus.message));
    return;
  }

  if (!peer || !["connected", "completed"].includes(iceState)) {
    setStatus("warning", "Connecting");
    setSignal("Connecting WebRTC", `Peer: ${webRtcState}, ICE: ${iceState}`);
    return;
  }

  if (!firstFrameReceived && performance.now() - connectedAt > 1200) {
    setStatus("warning", "No screen");
    setSignal("Waiting for video", captureStatus.message || "Waiting for the WebRTC video track.");
    return;
  }

  setStatus("connected", dataChannelState === "open" ? "Connected" : "Video connected");
  hideSignal();
}

function connect() {
  window.clearTimeout(reconnectTimer);
  window.clearInterval(signalTimer);
  closePeer();

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  socket.addEventListener("open", () => {
    connected = true;
    connectedAt = performance.now();
    firstFrameReceived = false;
    webRtcState = "new";
    iceState = "new";
    dataChannelState = "connecting";
    reconnectDelay = 500;
    setStatus("connected", "Connected");
    sendMessage({ type: "hello", quality: currentQuality });
    updateOwnership();
    updateSignal();
    signalTimer = window.setInterval(updateSignal, 800);
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      void handleServerMessage(event.data);
    }
  });

  socket.addEventListener("close", scheduleReconnect);
  socket.addEventListener("error", scheduleReconnect);
}

function scheduleReconnect() {
  if (!connected && reconnectTimer) {
    return;
  }
  connected = false;
  canControl = false;
  setStatus("disconnected", "Reconnecting");
  updateOwnership();
  updateSignal();
  closePeer();
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(5000, Math.floor(reconnectDelay * 1.6));
}

function sendMessage(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function handleServerMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  if (message.type === "hello") {
    canControl = Boolean(message.canControl);
    syncQuality(message.quality);
    updateOwnership();
  } else if (message.type === "status") {
    canControl = Boolean(message.canControl);
    syncQuality(message.quality);
    if (Object.prototype.hasOwnProperty.call(message, "hasFrame")) {
      captureStatus = {
        ...captureStatus,
        hasFrame: Boolean(message.hasFrame),
        blankFrame: Boolean(message.blankFrame),
        state: message.captureState || captureStatus.state
      };
    }
    updateOwnership();
  } else if (message.type === "quality") {
    syncQuality(message.quality);
  } else if (message.type === "meta") {
    frameMeta = message;
    captureStatus = {
      ...captureStatus,
      hasFrame: true,
      blankFrame: Boolean(message.blankFrame)
    };
    updateSignal();
  } else if (message.type === "capture") {
    captureStatus = {
      ...captureStatus,
      ...message
    };
    updateSignal();
  } else if (message.type === "webrtc-offer") {
    await acceptOffer(message.offer);
  } else if (message.type === "webrtc-ice") {
    await addRemoteIce(message.candidate);
  } else if (message.type === "webrtc-state") {
    webRtcState = message.connectionState || webRtcState;
    iceState = message.iceConnectionState || iceState;
    updateSignal();
  } else if (message.type === "datachannel") {
    dataChannelState = message.readyState || dataChannelState;
    updateSignal();
  } else if (message.type === "error") {
    setStatus("warning", "Error");
    setSignal("WebRTC error", message.message || "Unknown signaling error.");
  }
}

function syncQuality(quality) {
  if (!quality) {
    return;
  }
  currentQuality = quality;
  qualitySelect.value = currentQuality;
}

async function acceptOffer(offer) {
  if (!offer?.sdp || offer.type !== "offer") {
    return;
  }

  const offerId = currentOfferId + 1;
  currentOfferId = offerId;
  closePeer();

  const pc = new RTCPeerConnection({ iceServers: [] });
  peer = pc;
  webRtcState = pc.connectionState;
  iceState = pc.iceConnectionState;

  pc.addEventListener("track", (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    screen.srcObject = stream;
    void screen.play().catch(() => {});
  });

  pc.addEventListener("datachannel", (event) => {
    attachInputChannel(event.channel);
  });

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendMessage({
        type: "webrtc-ice",
        candidate: event.candidate.toJSON()
      });
    }
  });

  pc.addEventListener("connectionstatechange", () => {
    webRtcState = pc.connectionState;
    updateSignal();
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    iceState = pc.iceConnectionState;
    updateSignal();
  });

  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGatheringComplete(pc, 1800);

  if (offerId !== currentOfferId || peer !== pc) {
    return;
  }

  sendMessage({
    type: "webrtc-answer",
    answer: pc.localDescription
  });
  updateSignal();
}

async function addRemoteIce(candidate) {
  if (!peer || !candidate) {
    return;
  }
  try {
    await peer.addIceCandidate(candidate);
  } catch {
    // Full SDP candidates are usually enough on LAN; stale trickle candidates can be ignored.
  }
}

function waitForIceGatheringComplete(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onStateChange);

    function onStateChange() {
      if (pc.iceGatheringState === "complete") {
        done();
      }
    }

    function done() {
      window.clearTimeout(timeout);
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    }
  });
}

function attachInputChannel(channel) {
  inputChannel = channel;
  dataChannelState = channel.readyState;
  channel.addEventListener("open", () => {
    dataChannelState = "open";
    updateSignal();
  });
  channel.addEventListener("close", () => {
    dataChannelState = "closed";
    updateSignal();
  });
  channel.addEventListener("error", () => {
    dataChannelState = "closed";
    updateSignal();
  });
}

function closePeer() {
  if (inputChannel) {
    try {
      inputChannel.close();
    } catch {
      // Best-effort cleanup.
    }
  }
  inputChannel = null;
  dataChannelState = "connecting";

  if (peer) {
    try {
      peer.close();
    } catch {
      // Best-effort cleanup.
    }
  }
  peer = null;
  screen.srcObject = null;
}

function updateScreenTransform() {
  screen.style.transform = `scale(${viewScale})`;
}

function getVideoFit() {
  const rect = screen.getBoundingClientRect();
  const sourceWidth = frameMeta?.frameWidth || screen.videoWidth || 16;
  const sourceHeight = frameMeta?.frameHeight || screen.videoHeight || 9;
  const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const x = rect.left + (rect.width - width) / 2;
  const y = rect.top + (rect.height - height) / 2;
  return { x, y, width, height };
}

function eventPoint(touch) {
  const fit = getVideoFit();
  const normalizedX = (touch.clientX - fit.x) / fit.width;
  const normalizedY = (touch.clientY - fit.y) / fit.height;

  return {
    x: Math.min(1, Math.max(0, normalizedX)),
    y: Math.min(1, Math.max(0, normalizedY)),
    clientX: touch.clientX,
    clientY: touch.clientY
  };
}

function distance(left, right) {
  return Math.hypot(left.clientX - right.clientX, left.clientY - right.clientY);
}

function center(left, right) {
  return {
    clientX: (left.clientX + right.clientX) / 2,
    clientY: (left.clientY + right.clientY) / 2
  };
}

function clearLongPress() {
  window.clearTimeout(longPressTimer);
  longPressTimer = null;
}

function canSendInput() {
  return connected &&
    canControl &&
    !monitorMode &&
    inputChannel?.readyState === "open";
}

function sendInput(action) {
  if (!canSendInput()) {
    return;
  }
  inputChannel.send(JSON.stringify({ type: "input", ...action }));
}

function handleTouchStart(event) {
  event.preventDefault();
  clearLongPress();
  rightClickSent = false;

  if (event.touches.length === 1) {
    const point = eventPoint(event.touches[0]);
    gesture = {
      type: "pointer",
      start: point,
      last: point,
      startTime: performance.now()
    };
    longPressTimer = window.setTimeout(() => {
      rightClickSent = true;
      sendInput({ action: "rightClick", x: point.x, y: point.y });
    }, 620);
  } else if (event.touches.length === 2) {
    const first = eventPoint(event.touches[0]);
    const second = eventPoint(event.touches[1]);
    const middle = center(first, second);
    gesture = {
      type: "pinch",
      startDistance: distance(first, second),
      startScale: viewScale,
      lastCenter: middle
    };
  }
}

function handleTouchMove(event) {
  event.preventDefault();

  if (event.touches.length === 1 && gesture?.type === "pointer") {
    const point = eventPoint(event.touches[0]);
    const moved = distance(gesture.start, point);
    if (moved > 10) {
      clearLongPress();
    }

    const now = performance.now();
    if (now - lastMoveSentAt > 24) {
      sendInput({ action: "move", x: point.x, y: point.y });
      lastMoveSentAt = now;
    }
    gesture.last = point;
  } else if (event.touches.length === 2) {
    clearLongPress();
    const first = eventPoint(event.touches[0]);
    const second = eventPoint(event.touches[1]);
    const middle = center(first, second);

    if (gesture?.type !== "pinch") {
      gesture = {
        type: "pinch",
        startDistance: distance(first, second),
        startScale: viewScale,
        lastCenter: middle
      };
      return;
    }

    const nextDistance = Math.max(16, distance(first, second));
    const scale = nextDistance / Math.max(16, gesture.startDistance);
    viewScale = Math.min(3, Math.max(1, gesture.startScale * scale));
    updateScreenTransform();

    const dy = middle.clientY - gesture.lastCenter.clientY;
    const dx = middle.clientX - gesture.lastCenter.clientX;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      sendInput({ action: "scroll", dx: dx * -2, dy: dy * -2 });
    }
    gesture.lastCenter = middle;
  }
}

function handleTouchEnd(event) {
  event.preventDefault();
  clearLongPress();

  if (gesture?.type === "pointer" && event.touches.length === 0) {
    const duration = performance.now() - gesture.startTime;
    const moved = distance(gesture.start, gesture.last);
    if (!rightClickSent && duration < 520 && moved < 12) {
      sendInput({ action: "click", x: gesture.last.x, y: gesture.last.y });
    }
    gesture = null;
  } else if (event.touches.length === 0) {
    gesture = null;
  }
}

function handleWheel(event) {
  event.preventDefault();
  sendInput({
    action: "scroll",
    dx: event.deltaX * -1,
    dy: event.deltaY * -1
  });
}

qualitySelect.addEventListener("change", () => {
  currentQuality = qualitySelect.value;
  sendMessage({ type: "quality", quality: currentQuality });
});

modeButton.addEventListener("click", () => {
  setMonitorMode(!monitorMode);
});

orientationButton.addEventListener("click", () => {
  if (landscapeSessionActive || orientationLockActive || fullscreenElement()) {
    void exitLandscape();
  } else {
    void enterLandscape();
  }
});

screen.addEventListener("loadeddata", () => {
  firstFrameReceived = true;
  updateSignal();
});
screen.addEventListener("playing", () => {
  firstFrameReceived = true;
  updateSignal();
});
screen.addEventListener("resize", () => {
  firstFrameReceived = true;
  updateSignal();
});

window.addEventListener("resize", updateScreenTransform);
window.addEventListener("orientationchange", () => {
  updateOrientationButton();
  updateScreenTransform();
});
window.screen?.orientation?.addEventListener?.("change", () => {
  updateOrientationButton();
  updateScreenTransform();
});
document.addEventListener("fullscreenchange", handleFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
screen.addEventListener("touchstart", handleTouchStart, { passive: false });
screen.addEventListener("touchmove", handleTouchMove, { passive: false });
screen.addEventListener("touchend", handleTouchEnd, { passive: false });
screen.addEventListener("touchcancel", handleTouchEnd, { passive: false });
screen.addEventListener("wheel", handleWheel, { passive: false });

setMonitorMode(false);
updateOrientationButton();
updateScreenTransform();
connect();
