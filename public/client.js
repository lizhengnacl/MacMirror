const screen = document.querySelector("#screen");
const appShell = document.querySelector(".app-shell");
const topBar = document.querySelector("#topBar");
const statusEl = document.querySelector("#status");
const statusText = document.querySelector("#statusText");
const qualitySelect = document.querySelector("#quality");
const modeButton = document.querySelector("#modeButton");
const orientationButton = document.querySelector("#orientationButton");
const controlsToggle = document.querySelector("#controlsToggle");
const controlsPeek = document.querySelector("#controlsPeek");
const monitorBadge = document.querySelector("#monitorBadge");
const ownership = document.querySelector("#ownership");
const signalPanel = document.querySelector("#signalPanel");
const signalTitle = document.querySelector("#signalTitle");
const signalBody = document.querySelector("#signalBody");

const CONTROLS_AUTO_HIDE_MS = 3200;
const HEARTBEAT_INTERVAL_MS = 3000;
const HEARTBEAT_TIMEOUT_MS = 9000;
const PEER_RECONNECT_DELAY_MS = 1800;
const MIN_VIEW_SCALE = 1;
const MAX_VIEW_SCALE = 3;
const USE_POINTER_EVENTS = Boolean(window.PointerEvent);

let socket = null;
let peer = null;
let inputChannel = null;
let reconnectTimer = null;
let peerReconnectTimer = null;
let heartbeatTimer = null;
let reconnectDelay = 500;
let signalTimer = null;
let controlsTimer = null;
let orientationMessageTimer = null;
let connected = false;
let canControl = false;
let monitorMode = false;
let controlsCollapsed = false;
let landscapeSessionActive = false;
let orientationLockActive = false;
let currentQuality = qualitySelect.value;
let currentOfferId = 0;
let webRtcState = "new";
let iceState = "new";
let dataChannelState = "connecting";
let lastPongAt = 0;
let frameMeta = null;
let firstFrameReceived = false;
let connectedAt = 0;
let viewScale = 1;
let viewOffsetX = 0;
let viewOffsetY = 0;
let gesture = null;
let mouseGesture = null;
let activePointers = new Map();
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

function setControlsCollapsed(collapsed) {
  controlsCollapsed = collapsed;
  appShell.classList.toggle("controls-collapsed", collapsed);
  controlsToggle.setAttribute("aria-label", collapsed ? "Show controls" : "Hide controls");
  controlsToggle.title = collapsed ? "Show controls" : "Hide controls";
}

function scheduleControlsCollapse(delay = CONTROLS_AUTO_HIDE_MS) {
  window.clearTimeout(controlsTimer);
  if (controlsCollapsed) {
    return;
  }

  controlsTimer = window.setTimeout(() => {
    if (topBar.contains(document.activeElement)) {
      scheduleControlsCollapse(delay);
      return;
    }
    setControlsCollapsed(true);
  }, delay);
}

function showControls({ autoHide = true } = {}) {
  window.clearTimeout(controlsTimer);
  setControlsCollapsed(false);
  if (autoHide) {
    scheduleControlsCollapse();
  }
}

function holdControls() {
  window.clearTimeout(controlsTimer);
  setControlsCollapsed(false);
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
  return message || "Grant Screen Recording permission to MacMirror or the terminal app that started it, then restart the service.";
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
  reconnectTimer = null;
  window.clearTimeout(peerReconnectTimer);
  peerReconnectTimer = null;
  window.clearInterval(signalTimer);
  window.clearInterval(heartbeatTimer);
  closePeer();

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const nextSocket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  socket = nextSocket;

  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) {
      return;
    }
    connected = true;
    connectedAt = performance.now();
    lastPongAt = performance.now();
    firstFrameReceived = false;
    webRtcState = "new";
    iceState = "new";
    dataChannelState = "connecting";
    reconnectDelay = 500;
    setStatus("connected", "Connected");
    sendMessage({ type: "hello", quality: currentQuality });
    updateOwnership();
    updateSignal();
    startHeartbeat();
    signalTimer = window.setInterval(updateSignal, 800);
  });

  nextSocket.addEventListener("message", (event) => {
    if (socket !== nextSocket) {
      return;
    }
    if (typeof event.data === "string") {
      void handleServerMessage(event.data);
    }
  });

  nextSocket.addEventListener("close", () => {
    if (socket === nextSocket) {
      scheduleReconnect();
    }
  });
  nextSocket.addEventListener("error", () => {
    if (socket === nextSocket) {
      scheduleReconnect();
    }
  });
}

function scheduleReconnect({ immediate = false } = {}) {
  if (!connected && reconnectTimer && !immediate) {
    return;
  }
  connected = false;
  canControl = false;
  webRtcState = "closed";
  iceState = "closed";
  setStatus("disconnected", "Reconnecting");
  updateOwnership();
  updateSignal();
  window.clearTimeout(peerReconnectTimer);
  peerReconnectTimer = null;
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  closePeer();
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, immediate ? 0 : reconnectDelay);
  if (!immediate) {
    reconnectDelay = Math.min(5000, Math.floor(reconnectDelay * 1.6));
  }
}

function startHeartbeat() {
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) {
      scheduleReconnect();
      return;
    }

    const now = performance.now();
    if (now - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
      try {
        socket.close();
      } catch {
        // The reconnect timer below is the authoritative recovery path.
      }
      scheduleReconnect({ immediate: true });
      return;
    }

    sendMessage({
      type: "ping",
      at: Date.now()
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function restartPeer() {
  window.clearTimeout(peerReconnectTimer);
  peerReconnectTimer = null;

  if (!connected || socket?.readyState !== WebSocket.OPEN) {
    scheduleReconnect({ immediate: true });
    return;
  }

  firstFrameReceived = false;
  connectedAt = performance.now();
  webRtcState = "new";
  iceState = "new";
  dataChannelState = "connecting";
  closePeer();
  setStatus("warning", "Reconnecting");
  setSignal("Reconnecting WebRTC", "Restoring the screen stream.");
  sendMessage({
    type: "hello",
    quality: currentQuality,
    reconnect: true
  });
}

function schedulePeerReconnect(reason, delay = PEER_RECONNECT_DELAY_MS) {
  if (!connected || peerReconnectTimer) {
    return;
  }

  setStatus("warning", "Reconnecting");
  setSignal("Reconnecting WebRTC", reason);
  peerReconnectTimer = window.setTimeout(restartPeer, delay);
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
  } else if (message.type === "pong") {
    lastPongAt = performance.now();
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
    if (peer !== pc) {
      return;
    }
    webRtcState = pc.connectionState;
    handlePeerConnectionState();
    updateSignal();
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    if (peer !== pc) {
      return;
    }
    iceState = pc.iceConnectionState;
    handlePeerConnectionState();
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

function handlePeerConnectionState() {
  if (
    webRtcState === "connected" ||
    iceState === "connected" ||
    iceState === "completed"
  ) {
    window.clearTimeout(peerReconnectTimer);
    peerReconnectTimer = null;
    return;
  }

  if (webRtcState === "failed" || iceState === "failed") {
    schedulePeerReconnect("The WebRTC connection failed. Reconnecting now.", 0);
    return;
  }

  if (webRtcState === "closed" || iceState === "closed") {
    schedulePeerReconnect("The WebRTC connection closed. Reconnecting now.", 0);
    return;
  }

  if (webRtcState === "disconnected" || iceState === "disconnected") {
    schedulePeerReconnect("The WebRTC connection was interrupted. Trying to recover.");
  }
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
    if (connected && peer) {
      schedulePeerReconnect("The control channel closed. Restoring the session.");
    }
    updateSignal();
  });
  channel.addEventListener("error", () => {
    dataChannelState = "closed";
    if (connected && peer) {
      schedulePeerReconnect("The control channel hit an error. Restoring the session.");
    }
    updateSignal();
  });
}

function closePeer() {
  const channel = inputChannel;
  const currentPeer = peer;
  inputChannel = null;
  peer = null;

  if (channel) {
    try {
      channel.close();
    } catch {
      // Best-effort cleanup.
    }
  }
  dataChannelState = "connecting";

  if (currentPeer) {
    try {
      currentPeer.close();
    } catch {
      // Best-effort cleanup.
    }
  }
  screen.srcObject = null;
}

function getScreenLayoutRect() {
  const width = screen.clientWidth || window.innerWidth;
  const height = screen.clientHeight || window.innerHeight;

  return {
    left: (window.innerWidth - width) / 2,
    top: (window.innerHeight - height) / 2,
    width,
    height
  };
}

function clampViewTransform() {
  if (viewScale <= MIN_VIEW_SCALE) {
    viewScale = MIN_VIEW_SCALE;
    viewOffsetX = 0;
    viewOffsetY = 0;
    return;
  }

  const rect = getScreenLayoutRect();
  const minX = rect.width * (1 - viewScale);
  const minY = rect.height * (1 - viewScale);
  viewOffsetX = Math.min(0, Math.max(minX, viewOffsetX));
  viewOffsetY = Math.min(0, Math.max(minY, viewOffsetY));
}

function updateScreenTransform() {
  clampViewTransform();
  screen.style.transform = `matrix(${viewScale}, 0, 0, ${viewScale}, ${viewOffsetX}, ${viewOffsetY})`;
}

function panViewBy(deltaX, deltaY) {
  if (viewScale <= MIN_VIEW_SCALE) {
    return;
  }

  viewOffsetX += deltaX;
  viewOffsetY += deltaY;
  updateScreenTransform();
}

function localPointFromClient(clientX, clientY) {
  const rect = getScreenLayoutRect();
  return {
    x: Math.min(rect.width, Math.max(0, clientX - rect.left)),
    y: Math.min(rect.height, Math.max(0, clientY - rect.top))
  };
}

function zoomAtClientPoint(point, nextScale) {
  const previousScale = viewScale;
  const targetScale = Math.min(MAX_VIEW_SCALE, Math.max(MIN_VIEW_SCALE, nextScale));

  if (Math.abs(targetScale - previousScale) < 0.001) {
    return;
  }

  const focal = localPointFromClient(point.clientX, point.clientY);
  const scaleRatio = targetScale / previousScale;
  viewOffsetX = focal.x - (focal.x - viewOffsetX) * scaleRatio;
  viewOffsetY = focal.y - (focal.y - viewOffsetY) * scaleRatio;
  viewScale = targetScale;
  updateScreenTransform();
}

function getVideoFit() {
  const layoutRect = getScreenLayoutRect();
  const rect = {
    left: layoutRect.left + viewOffsetX,
    top: layoutRect.top + viewOffsetY,
    width: layoutRect.width * viewScale,
    height: layoutRect.height * viewScale
  };
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

    const dy = middle.clientY - gesture.lastCenter.clientY;
    const dx = middle.clientX - gesture.lastCenter.clientX;
    const nextDistance = Math.max(16, distance(first, second));
    const scale = nextDistance / Math.max(16, gesture.startDistance);
    zoomAtClientPoint(middle, gesture.startScale * scale);
    panViewBy(dx, dy);

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

function firstTwoActivePointers() {
  const pointers = activePointers.values();
  const first = pointers.next().value;
  const second = pointers.next().value;
  return [first, second];
}

function beginPointerTap(pointerId, point) {
  clearLongPress();
  rightClickSent = false;
  gesture = {
    type: "pointer",
    pointerId,
    start: point,
    last: point,
    startTime: performance.now()
  };
  longPressTimer = window.setTimeout(() => {
    if (gesture?.type !== "pointer" || gesture.pointerId !== pointerId) {
      return;
    }
    rightClickSent = true;
    sendInput({ action: "rightClick", x: gesture.last.x, y: gesture.last.y });
  }, 620);
}

function beginPointerPinch() {
  clearLongPress();
  const [first, second] = firstTwoActivePointers();
  if (!first || !second) {
    return;
  }
  gesture = {
    type: "pinch",
    startDistance: distance(first, second),
    startScale: viewScale,
    lastCenter: center(first, second)
  };
}

function updatePointerPinch() {
  const [first, second] = firstTwoActivePointers();
  if (!first || !second) {
    return;
  }
  const middle = center(first, second);

  if (gesture?.type !== "pinch") {
    beginPointerPinch();
    return;
  }

  const dy = middle.clientY - gesture.lastCenter.clientY;
  const dx = middle.clientX - gesture.lastCenter.clientX;
  const nextDistance = Math.max(16, distance(first, second));
  const scale = nextDistance / Math.max(16, gesture.startDistance);
  zoomAtClientPoint(middle, gesture.startScale * scale);
  panViewBy(dx, dy);

  gesture.lastCenter = middle;
}

function handlePointerDown(event) {
  if (event.pointerType === "mouse") {
    handleMouseDown(event);
    return;
  }

  event.preventDefault();
  const point = eventPoint(event);
  activePointers.set(event.pointerId, point);
  screen.setPointerCapture?.(event.pointerId);

  if (activePointers.size === 1) {
    beginPointerTap(event.pointerId, point);
  } else if (activePointers.size === 2) {
    beginPointerPinch();
  } else {
    clearLongPress();
  }
}

function handlePointerMove(event) {
  if (event.pointerType === "mouse") {
    handleMouseMove(event);
    return;
  }

  if (!activePointers.has(event.pointerId)) {
    return;
  }

  event.preventDefault();
  const point = eventPoint(event);
  activePointers.set(event.pointerId, point);

  if (activePointers.size === 1 && gesture?.type === "pointer" && gesture.pointerId === event.pointerId) {
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
  } else if (activePointers.size >= 2) {
    clearLongPress();
    updatePointerPinch();
  }
}

function finishPointer(event, { canceled = false } = {}) {
  if (event.pointerType === "mouse") {
    if (canceled) {
      handleMouseCancel(event);
    } else {
      handleMouseUp(event);
    }
    return;
  }

  if (!activePointers.has(event.pointerId)) {
    return;
  }

  event.preventDefault();
  const point = eventPoint(event);

  if (!canceled && gesture?.type === "pointer" && gesture.pointerId === event.pointerId && activePointers.size === 1) {
    gesture.last = point;
    const duration = performance.now() - gesture.startTime;
    const moved = distance(gesture.start, gesture.last);
    if (!rightClickSent && duration < 520 && moved < 12) {
      sendInput({ action: "click", x: point.x, y: point.y });
    }
  }

  activePointers.delete(event.pointerId);
  clearLongPress();
  screen.releasePointerCapture?.(event.pointerId);

  if (activePointers.size === 0) {
    gesture = null;
    return;
  }

  if (gesture?.type === "pinch" && activePointers.size >= 2) {
    beginPointerPinch();
  }
}

function handlePointerUp(event) {
  finishPointer(event);
}

function handlePointerCancel(event) {
  finishPointer(event, { canceled: true });
}

function handleMouseDown(event) {
  if (event.button === 2) {
    event.preventDefault();
    const point = eventPoint(event);
    sendInput({ action: "rightClick", x: point.x, y: point.y });
    return;
  }

  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  const point = eventPoint(event);
  mouseGesture = {
    start: point,
    last: point,
    startTime: performance.now()
  };
  screen.setPointerCapture?.(event.pointerId);
}

function handleMouseMove(event) {
  if (!mouseGesture) {
    return;
  }

  event.preventDefault();
  const point = eventPoint(event);
  const now = performance.now();
  if (now - lastMoveSentAt > 24) {
    sendInput({ action: "move", x: point.x, y: point.y });
    lastMoveSentAt = now;
  }
  mouseGesture.last = point;
}

function handleMouseUp(event) {
  if (!mouseGesture || event.button !== 0) {
    return;
  }

  event.preventDefault();
  const point = eventPoint(event);
  mouseGesture.last = point;
  const moved = distance(mouseGesture.start, mouseGesture.last);
  if (moved < 12) {
    sendInput({ action: "click", x: point.x, y: point.y });
  }
  mouseGesture = null;
  screen.releasePointerCapture?.(event.pointerId);
}

function handleMouseCancel(event) {
  mouseGesture = null;
  if (event.pointerId !== undefined) {
    screen.releasePointerCapture?.(event.pointerId);
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

function recoverActiveSession() {
  if (document.hidden) {
    return;
  }

  if (!connected || socket?.readyState !== WebSocket.OPEN) {
    scheduleReconnect({ immediate: true });
    return;
  }

  if (
    !peer ||
    webRtcState === "failed" ||
    webRtcState === "disconnected" ||
    webRtcState === "closed" ||
    iceState === "failed" ||
    iceState === "disconnected" ||
    iceState === "closed"
  ) {
    restartPeer();
    return;
  }

  sendMessage({
    type: "ping",
    at: Date.now()
  });
}

qualitySelect.addEventListener("change", () => {
  currentQuality = qualitySelect.value;
  sendMessage({ type: "quality", quality: currentQuality });
  scheduleControlsCollapse(1600);
});

modeButton.addEventListener("click", () => {
  setMonitorMode(!monitorMode);
  scheduleControlsCollapse(1600);
});

orientationButton.addEventListener("click", () => {
  if (landscapeSessionActive || orientationLockActive || fullscreenElement()) {
    void exitLandscape();
  } else {
    void enterLandscape();
  }
  scheduleControlsCollapse(1600);
});

controlsToggle.addEventListener("click", () => {
  setControlsCollapsed(true);
});

controlsPeek.addEventListener("click", () => {
  showControls();
});

topBar.addEventListener("pointerdown", holdControls);
topBar.addEventListener("pointerup", () => scheduleControlsCollapse());
topBar.addEventListener("pointercancel", () => scheduleControlsCollapse());
topBar.addEventListener("focusin", holdControls);
topBar.addEventListener("focusout", () => {
  window.setTimeout(() => {
    if (!topBar.contains(document.activeElement)) {
      scheduleControlsCollapse();
    }
  });
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
window.addEventListener("online", recoverActiveSession);
window.addEventListener("offline", () => {
  setStatus("disconnected", "Offline");
  setSignal("Network offline", "MacMirror will reconnect when the browser is back online.");
});
window.addEventListener("pageshow", recoverActiveSession);
window.screen?.orientation?.addEventListener?.("change", () => {
  updateOrientationButton();
  updateScreenTransform();
});
document.addEventListener("fullscreenchange", handleFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
document.addEventListener("visibilitychange", recoverActiveSession);
if (USE_POINTER_EVENTS) {
  screen.addEventListener("pointerdown", handlePointerDown);
  screen.addEventListener("pointermove", handlePointerMove);
  screen.addEventListener("pointerup", handlePointerUp);
  screen.addEventListener("pointercancel", handlePointerCancel);
} else {
  screen.addEventListener("touchstart", handleTouchStart, { passive: false });
  screen.addEventListener("touchmove", handleTouchMove, { passive: false });
  screen.addEventListener("touchend", handleTouchEnd, { passive: false });
  screen.addEventListener("touchcancel", handleTouchEnd, { passive: false });
}
screen.addEventListener("contextmenu", (event) => event.preventDefault());
screen.addEventListener("wheel", handleWheel, { passive: false });

setMonitorMode(false);
updateOrientationButton();
updateScreenTransform();
showControls();
connect();
