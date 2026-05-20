#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MediaStreamTrack, RTCPeerConnection, useH264 } from "werift";
import { createH264RtpState, packetizeAnnexBFrame } from "./h264-rtp.js";
import { renderQrSvg, renderQrTerminal } from "./qr.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const CAPTURE_SCRIPT = path.join(ROOT_DIR, "native", "MacMirrorH264Capture.swift");
const INPUT_SCRIPT = path.join(ROOT_DIR, "native", "MacMirrorInput.swift");
const NATIVE_BUILD_DIR = path.join(ROOT_DIR, ".macmirror", "bin");
const CAPTURE_BINARY = path.join(NATIVE_BUILD_DIR, "MacMirrorH264Capture");
const INPUT_BINARY = path.join(NATIVE_BUILD_DIR, "MacMirrorInput");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const VALID_QUALITIES = new Set(["smooth", "balanced", "high"]);
const QUALITY_PROFILES = {
  smooth: { fps: 30, maxHeight: 720, bitrate: 2_500_000 },
  balanced: { fps: 30, maxHeight: 1080, bitrate: 5_000_000 },
  high: { fps: 30, maxHeight: 0, bitrate: 8_000_000 }
};
const WEBRTC_INPUT_CHANNEL = "input";
const H264_FMTP = "profile-level-id=42c01f;packetization-mode=1;level-asymmetry-allowed=1";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function needsBuild(source, output) {
  try {
    const sourceStat = fsSync.statSync(source);
    const outputStat = fsSync.statSync(output);
    return outputStat.mtimeMs < sourceStat.mtimeMs || outputStat.size === 0;
  } catch {
    return true;
  }
}

function buildNativeHelper(source, output) {
  if (!needsBuild(source, output)) {
    return;
  }

  fsSync.mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync("swiftc", ["-O", source, "-o", output], {
    cwd: ROOT_DIR,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(details || `swiftc exited with code ${result.status}`);
  }
}

function parseArgs(argv) {
  const options = {
    port: 8080,
    host: null,
    quality: "balanced",
    noCapture: process.env.MACMIRROR_NO_CAPTURE === "1"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--port" || arg === "-p") {
      options.port = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--port=")) {
      options.port = Number(arg.slice("--port=".length));
    } else if (arg === "--host") {
      options.host = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--quality" || arg === "-q") {
      options.quality = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--quality=")) {
      options.quality = arg.slice("--quality=".length);
    } else if (arg === "--no-capture") {
      options.noCapture = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("Port must be an integer from 0 to 65535");
  }
  if (!VALID_QUALITIES.has(options.quality)) {
    throw new Error("Quality must be smooth, balanced, or high");
  }

  return options;
}

function printHelp() {
  console.log(`MacMirror

Usage:
  macmirror [--port 8080] [--host 192.168.1.10] [--quality balanced]

Options:
  --port, -p       HTTP port. Default: 8080
  --host           Bind host. Default: first private LAN IPv4
  --quality, -q    smooth, balanced, or high. Default: balanced
  --no-capture     Start the web server without the native capture process
  --help, -h       Show this help
`);
}

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      addresses.push(entry.address);
    }
  }

  return addresses;
}

function isPrivateIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254);
}

function chooseDefaultHost() {
  const addresses = getLanAddresses();
  return addresses.find(isPrivateIPv4) ?? addresses[0] ?? "127.0.0.1";
}

function publicHostForUrl(bindHost) {
  if (bindHost === "0.0.0.0" || bindHost === "::") {
    return chooseDefaultHost();
  }
  return bindHost;
}

function encodeWebSocketFrame(payload, opcode) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function normalizeJpegFrame(frame) {
  if (frame.length < 8) {
    return frame;
  }
  if (frame[0] === 0xff && frame[1] === 0xd8) {
    return frame;
  }

  const signature = frame.subarray(2, 6).toString("ascii");
  if (frame[0] === 0x00 && signature === "JFIF") {
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), frame]);
  }
  if (frame[0] === 0x00 && frame.subarray(2, 6).toString("ascii") === "Exif") {
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), frame]);
  }

  return frame;
}

function sendFrame(client, payload, opcode) {
  if (client.socket.destroyed) {
    return false;
  }
  return client.socket.write(encodeWebSocketFrame(payload, opcode));
}

function sendText(client, message) {
  sendFrame(client, Buffer.from(JSON.stringify(message)), 0x1);
}

function parseClientFrames(client, chunk, onMessage) {
  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (client.buffer.length >= 2) {
    const firstByte = client.buffer[0];
    const secondByte = client.buffer[1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (client.buffer.length < offset + 2) {
        return;
      }
      payloadLength = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (client.buffer.length < offset + 8) {
        return;
      }
      const bigLength = client.buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        client.socket.destroy();
        return;
      }
      payloadLength = Number(bigLength);
      offset += 8;
    }

    if (masked) {
      if (client.buffer.length < offset + 4) {
        return;
      }
    } else {
      client.socket.destroy();
      return;
    }

    const mask = client.buffer.subarray(offset, offset + 4);
    offset += 4;

    if (client.buffer.length < offset + payloadLength) {
      return;
    }

    const payload = Buffer.from(client.buffer.subarray(offset, offset + payloadLength));
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }
    client.buffer = client.buffer.subarray(offset + payloadLength);

    if (opcode === 0x8) {
      client.socket.end(encodeWebSocketFrame(Buffer.alloc(0), 0x8));
      return;
    }
    if (opcode === 0x9) {
      sendFrame(client, payload, 0xA);
      continue;
    }
    if (opcode === 0x1) {
      onMessage(payload.toString("utf8"));
    }
  }
}

class CaptureProcess {
  constructor({ quality, noCapture, onFrame, onMeta, onStatus, onExit }) {
    this.quality = quality;
    this.noCapture = noCapture;
    this.onFrame = onFrame;
    this.onMeta = onMeta;
    this.onStatus = onStatus;
    this.onExit = onExit;
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.lastStderr = "";
    this.expectedStops = new WeakSet();
  }

  start() {
    if (this.noCapture) {
      this.onStatus?.({
        state: "disabled",
        message: "Capture is disabled because the server was started with --no-capture."
      });
      return;
    }

    const profile = QUALITY_PROFILES[this.quality];
    this.onStatus?.({
      state: "starting",
      message: "Starting the macOS screen capture helper."
    });

    try {
      buildNativeHelper(CAPTURE_SCRIPT, CAPTURE_BINARY);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[capture] failed to build Swift helper: ${message}`);
      this.onStatus?.({
        state: "error",
        message: `Failed to build Swift capture helper: ${message}`
      });
      return;
    }

    const args = [
      "--fps",
      String(profile.fps),
      "--max-height",
      String(profile.maxHeight),
      "--bitrate",
      String(profile.bitrate)
    ];

    const proc = spawn(CAPTURE_BINARY, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc = proc;

    proc.stdin.on("error", () => {
      // The helper can exit while a pending WebRTC PLI requests a key frame.
    });

    proc.stdout.on("data", (chunk) => {
      if (this.proc !== proc) {
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parseBuffer();
    });

    proc.stderr.on("data", (chunk) => {
      if (this.proc !== proc && this.expectedStops.has(proc)) {
        return;
      }
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.lastStderr = text;
        console.error(`[capture] ${text}`);
        this.onStatus?.({
          state: "warning",
          message: text
        });
      }
    });

    proc.on("error", (error) => {
      console.error(`[capture] failed to start Swift helper: ${error.message}`);
      this.onStatus?.({
        state: "error",
        message: `Failed to start Swift capture helper: ${error.message}`
      });
      this.onExit?.(error);
    });

    proc.on("spawn", () => {
      this.onStatus?.({
        state: "running",
        message: "Capture helper is running."
      });
    });

    proc.on("exit", (code, signal) => {
      if (this.expectedStops.has(proc)) {
        if (this.proc === proc) {
          this.proc = null;
        }
        return;
      }

      if (code !== null && code !== 0) {
        console.error(`[capture] exited with code ${code}`);
        this.onStatus?.({
          state: "error",
          message: this.lastStderr
            ? `Capture helper exited with code ${code}: ${this.lastStderr}`
            : `Capture helper exited with code ${code}.`
        });
      } else if (signal) {
        console.error(`[capture] stopped by ${signal}`);
        this.onStatus?.({
          state: "stopped",
          message: `Capture helper stopped by ${signal}.`
        });
      } else {
        this.onStatus?.({
          state: "stopped",
          message: "Capture helper stopped."
        });
      }
      if (this.proc === proc) {
        this.proc = null;
      }
      this.onExit?.();
    });
  }

  stop({ expected = false } = {}) {
    if (!this.proc || this.proc.killed) {
      return;
    }
    if (expected) {
      this.expectedStops.add(this.proc);
    }
    this.proc.kill("SIGTERM");
  }

  requestKeyFrame() {
    if (!this.proc?.stdin?.writable) {
      return;
    }
    try {
      this.proc.stdin.write("keyframe\n");
    } catch {
      // Best-effort; the next periodic key frame will recover the stream.
    }
  }

  restart(quality) {
    this.quality = quality;
    this.buffer = Buffer.alloc(0);
    this.onStatus?.({
      state: "starting",
      message: "Switching capture quality."
    });
    this.stop({ expected: true });
    this.start();
  }

  parseBuffer() {
    while (true) {
      const newlineIndex = this.buffer.indexOf(0x0a);
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer.subarray(0, newlineIndex).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let packet;
      try {
        packet = JSON.parse(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[capture] dropped invalid capture packet: ${message}`);
        continue;
      }

      if (typeof packet.payload !== "string") {
        console.error("[capture] dropped capture packet without payload");
        continue;
      }

      const payload = normalizeJpegFrame(Buffer.from(packet.payload, "base64"));
      delete packet.payload;
      this.onMeta?.(packet);
      this.onFrame?.(payload, packet);
    }
  }

}

class InputProcess {
  constructor() {
    this.proc = null;
    this.available = false;
  }

  start() {
    try {
      buildNativeHelper(INPUT_SCRIPT, INPUT_BINARY);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.available = false;
      console.error(`[input] failed to build Swift helper: ${message}`);
      return;
    }

    this.proc = spawn(INPUT_BINARY, [], {
      stdio: ["pipe", "ignore", "pipe"]
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.error(`[input] ${text}`);
      }
    });

    this.proc.on("error", (error) => {
      this.available = false;
      console.error(`[input] failed to start Swift helper: ${error.message}`);
    });

    this.proc.on("spawn", () => {
      this.available = true;
    });

    this.proc.on("exit", (code, signal) => {
      this.available = false;
      if (code !== null && code !== 0) {
        console.error(`[input] exited with code ${code}`);
      } else if (signal) {
        console.error(`[input] stopped by ${signal}`);
      }
    });
  }

  stop() {
    if (!this.proc || this.proc.killed) {
      return;
    }
    this.proc.kill("SIGTERM");
    this.proc = null;
    this.available = false;
  }

  send(action) {
    if (!this.available || !this.proc?.stdin?.writable) {
      return;
    }

    if (action.action === "scroll") {
      const dx = clampNumber(action.dx, -2000, 2000);
      const dy = clampNumber(action.dy, -2000, 2000);
      this.proc.stdin.write(`scroll ${dx.toFixed(2)} ${dy.toFixed(2)}\n`);
      return;
    }

    const x = clampNumber(action.x, 0, 1);
    const y = clampNumber(action.y, 0, 1);
    if (action.action === "move") {
      this.proc.stdin.write(`move ${x.toFixed(6)} ${y.toFixed(6)}\n`);
    } else if (action.action === "click") {
      this.proc.stdin.write(`click ${x.toFixed(6)} ${y.toFixed(6)}\n`);
    } else if (action.action === "rightClick") {
      this.proc.stdin.write(`right-click ${x.toFixed(6)} ${y.toFixed(6)}\n`);
    }
  }
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.min(max, Math.max(min, number));
}

async function serveFile(response, fileName) {
  const filePath = path.join(PUBLIC_DIR, fileName);
  const extension = path.extname(filePath);
  const content = await fs.readFile(filePath);
  response.writeHead(200, {
    "content-type": MIME_TYPES[extension] ?? "application/octet-stream",
    "cache-control": "no-store"
  });
  response.end(content);
}

function makeServerState(options) {
  return {
    options,
    quality: options.quality,
    lastMeta: null,
    lastMetaSignature: null,
    lastFrame: null,
    frameSeq: 0,
    capture: {
      state: "starting",
      message: "Capture has not started yet.",
      hasFrame: false,
      frameCount: 0,
      blankFrame: false,
      averageLuma: null,
      darkRatio: null,
      updatedAt: Date.now()
    },
    clients: new Map(),
    nextClientId: 1,
    controllerId: null,
    accessUrl: null
  };
}

function broadcast(state, message) {
  for (const client of state.clients.values()) {
    sendText(client, message);
  }
}

function captureStatusMessage(state) {
  return {
    type: "capture",
    ...state.capture
  };
}

function broadcastCaptureStatus(state) {
  broadcast(state, captureStatusMessage(state));
}

function broadcastStatus(state) {
  for (const client of state.clients.values()) {
    sendText(client, {
      type: "status",
      connected: true,
      transport: "webrtc",
      quality: state.quality,
      viewers: state.clients.size,
      hasFrame: state.capture.hasFrame,
      captureState: state.capture.state,
      blankFrame: state.capture.blankFrame,
      canControl: client.id === state.controllerId
    });
  }
}

function createWebRtcPeerConnection() {
  return new RTCPeerConnection({
    codecs: {
      video: [useH264({ parameters: H264_FMTP })]
    },
    iceServers: []
  });
}

function attachInputChannel(state, input, client, channel) {
  client.inputChannel = channel;
  channel.onMessage.subscribe((data) => {
    const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    handleInputChannelMessage(state, input, client, raw);
  });
  channel.stateChange.subscribe((readyState) => {
    sendText(client, {
      type: "datachannel",
      label: channel.label,
      readyState
    });
  });
}

function handleInputChannelMessage(state, input, client, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    return;
  }

  if (message.type !== "input" || client.id !== state.controllerId) {
    return;
  }

  input.send(message);
}

async function startWebRtcPeer(state, input, capture, client) {
  await closeWebRtcPeer(client);

  const pc = createWebRtcPeerConnection();
  const videoTrack = new MediaStreamTrack({ kind: "video" });
  const sender = pc.addTrack(videoTrack);
  const inputChannel = pc.createDataChannel(WEBRTC_INPUT_CHANNEL, {
    ordered: false,
    maxRetransmits: 0
  });

  client.webRtc = {
    pc,
    videoTrack,
    sender,
    rtpState: createH264RtpState(),
    ready: false
  };

  attachInputChannel(state, input, client, inputChannel);

  sender.onPictureLossIndication.subscribe(() => {
    capture.requestKeyFrame();
  });
  sender.onReady.subscribe(() => {
    capture.requestKeyFrame();
  });
  pc.connectionStateChange.subscribe((connectionState) => {
    sendText(client, {
      type: "webrtc-state",
      connectionState,
      iceConnectionState: pc.iceConnectionState
    });
    broadcastStatus(state);
  });
  pc.iceConnectionStateChange.subscribe((iceConnectionState) => {
    sendText(client, {
      type: "webrtc-state",
      connectionState: pc.connectionState,
      iceConnectionState
    });
  });
  pc.onIceCandidate.subscribe((candidate) => {
    if (!candidate) {
      return;
    }
    sendText(client, {
      type: "webrtc-ice",
      candidate: typeof candidate.toJSON === "function" ? candidate.toJSON() : candidate
    });
  });

  const offer = await pc.createOffer();
  const localDescription = await pc.setLocalDescription(offer);
  sendText(client, {
    type: "webrtc-offer",
    offer: localDescription.toSdp()
  });
  capture.requestKeyFrame();
}

async function closeWebRtcPeer(client) {
  const peer = client.webRtc;
  client.webRtc = null;
  client.inputChannel = null;
  if (!peer?.pc) {
    return;
  }
  try {
    await peer.pc.close();
  } catch {
    // Closing is best-effort during socket teardown.
  }
}

async function handleWebRtcAnswer(client, answer) {
  if (!client.webRtc?.pc || !answer?.sdp || answer.type !== "answer") {
    return;
  }
  await client.webRtc.pc.setRemoteDescription(answer);
  client.webRtc.ready = true;
}

async function handleWebRtcIce(client, candidate) {
  if (!client.webRtc?.pc || !candidate) {
    return;
  }
  await client.webRtc.pc.addIceCandidate(candidate);
}

function sendWebRtcFrame(client, frame, meta) {
  const peer = client.webRtc;
  if (!peer?.videoTrack || !peer.rtpState || peer.pc.connectionState === "closed") {
    return;
  }

  try {
    const packets = packetizeAnnexBFrame(frame, meta, peer.rtpState);
    for (const packet of packets) {
      peer.videoTrack.writeRtp(packet);
    }
  } catch (error) {
    console.error(`[webrtc] failed to packetize H.264 frame: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function broadcastWebRtcFrame(state, frame, meta) {
  if (meta?.codec !== "h264") {
    return;
  }
  for (const client of state.clients.values()) {
    sendWebRtcFrame(client, frame, meta);
  }
}

function metaSignature(meta) {
  return JSON.stringify({
    codec: meta.codec,
    codecString: meta.codecString,
    frameWidth: meta.frameWidth,
    frameHeight: meta.frameHeight,
    screenWidth: meta.screenWidth,
    screenHeight: meta.screenHeight,
    blankFrame: Boolean(meta.blankFrame)
  });
}

function assignController(state) {
  if (state.controllerId !== null && state.clients.has(state.controllerId)) {
    return;
  }

  const first = state.clients.keys().next();
  state.controllerId = first.done ? null : first.value;
}

async function handleClientMessage(state, input, capture, client, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    return;
  }

  if (message.type === "hello") {
    if (VALID_QUALITIES.has(message.quality) && message.quality !== state.quality) {
      state.quality = message.quality;
      capture.restart(state.quality);
    }
    await startWebRtcPeer(state, input, capture, client);
    broadcastStatus(state);
    return;
  }

  if (message.type === "quality" && VALID_QUALITIES.has(message.quality)) {
    if (message.quality !== state.quality) {
      state.quality = message.quality;
      capture.restart(state.quality);
      broadcast(state, {
        type: "quality",
        quality: state.quality
      });
    }
    broadcastStatus(state);
    return;
  }

  if (message.type === "webrtc-answer") {
    await handleWebRtcAnswer(client, message.answer);
    capture.requestKeyFrame();
    return;
  }

  if (message.type === "webrtc-ice") {
    await handleWebRtcIce(client, message.candidate);
    return;
  }

  if (message.type === "input") {
    if (client.id !== state.controllerId) {
      return;
    }
    input.send(message);
  }
}

function handleUpgrade(state, input, capture, request, socket) {
  if (!request.url?.startsWith("/ws")) {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const client = {
    id: state.nextClientId,
    socket,
    buffer: Buffer.alloc(0),
    webRtc: null,
    inputChannel: null
  };
  state.nextClientId += 1;
  state.clients.set(client.id, client);
  assignController(state);

  sendText(client, {
    type: "hello",
    id: client.id,
    quality: state.quality,
    canControl: client.id === state.controllerId
  });
  sendText(client, captureStatusMessage(state));

  if (state.lastMeta) {
    sendText(client, {
      type: "meta",
      quality: state.quality,
      ...state.lastMeta
    });
  }
  broadcastStatus(state);
  console.log(`[clients] ${state.clients.size} connected; controller=${state.controllerId ?? "none"}`);

  socket.on("data", (chunk) => {
    parseClientFrames(client, chunk, (message) => {
      void handleClientMessage(state, input, capture, client, message).catch((error) => {
        console.error(`[client ${client.id}] ${error instanceof Error ? error.message : String(error)}`);
        sendText(client, {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      });
    });
  });

  const removeClient = () => {
    if (!state.clients.has(client.id)) {
      return;
    }
    state.clients.delete(client.id);
    if (state.controllerId === client.id) {
      state.controllerId = null;
      assignController(state);
    }
    void closeWebRtcPeer(client);
    broadcastStatus(state);
    console.log(`[clients] ${state.clients.size} connected; controller=${state.controllerId ?? "none"}`);
  };

  socket.on("close", removeClient);
  socket.on("end", removeClient);
  socket.on("error", removeClient);
}

async function handleHttpRequest(state, request, response) {
  try {
    const url = new URL(request.url ?? "/", state.accessUrl ?? "http://localhost");

    if (url.pathname === "/" || url.pathname === "/index.html") {
      await serveFile(response, "index.html");
      return;
    }
    if (url.pathname === "/client.js") {
      await serveFile(response, "client.js");
      return;
    }
    if (url.pathname === "/styles.css") {
      await serveFile(response, "styles.css");
      return;
    }
    if (url.pathname === "/manifest.webmanifest") {
      await serveFile(response, "manifest.webmanifest");
      return;
    }
    if (url.pathname === "/qr.svg") {
      const target = url.searchParams.get("url") || state.accessUrl || "http://localhost";
      response.writeHead(200, {
        "content-type": MIME_TYPES[".svg"],
        "cache-control": "no-store"
      });
      response.end(await renderQrSvg(target));
      return;
    }
    if (url.pathname === "/frame.jpg") {
      if (!state.lastFrame || state.lastMeta?.codec === "h264") {
        response.writeHead(204, {
          "cache-control": "no-store"
        });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store"
      });
      response.end(state.lastFrame);
      return;
    }
    if (url.pathname === "/health") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify({
        ok: true,
        quality: state.quality,
        viewers: state.clients.size,
        hasFrame: state.lastFrame !== null,
        capture: state.capture,
        meta: state.lastMeta
      }));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
}

async function printStartup(state) {
  console.log("");
  console.log("MacMirror is running");
  console.log("");
  console.log(`URL: ${state.accessUrl}`);
  console.log("");
  console.log(await renderQrTerminal(state.accessUrl));
  console.log("");
  console.log("Open the URL on a phone connected to the same LAN.");
  console.log("If the image is black, allow Screen Recording for this terminal app.");
  console.log("If control does not work, allow Accessibility for this terminal app.");
  console.log("Press Ctrl+C to stop.");
  console.log("");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (options.help) {
    printHelp();
    return;
  }

  const host = options.host ?? chooseDefaultHost();
  const state = makeServerState(options);
  const input = new InputProcess();
  const capture = new CaptureProcess({
    quality: state.quality,
    noCapture: options.noCapture,
    onStatus(status) {
      state.capture = {
        ...state.capture,
        ...status,
        updatedAt: Date.now()
      };
      broadcastCaptureStatus(state);
    },
    onMeta(meta) {
      const changed = metaSignature(meta) !== state.lastMetaSignature;
      state.lastMeta = meta;
      state.lastMetaSignature = metaSignature(meta);
      state.capture = {
        ...state.capture,
        state: meta.blankFrame ? "warning" : "running",
        message: meta.blankFrame
          ? "The capture helper is receiving blank frames. Grant Screen Recording permission to the terminal app, then restart MacMirror."
          : "Capture helper is receiving screen frames.",
        hasFrame: true,
        frameCount: state.capture.frameCount + 1,
        blankFrame: Boolean(meta.blankFrame),
        averageLuma: Number.isFinite(meta.averageLuma) ? meta.averageLuma : null,
        darkRatio: Number.isFinite(meta.darkRatio) ? meta.darkRatio : null,
        updatedAt: Date.now()
      };
      if (changed) {
        broadcast(state, {
          type: "meta",
          quality: state.quality,
          ...meta
        });
        broadcastCaptureStatus(state);
      }
    },
    onFrame(frame, meta) {
      state.lastFrame = frame;
      state.frameSeq += 1;
      broadcastWebRtcFrame(state, frame, meta);
    }
  });

  const server = http.createServer((request, response) => {
    void handleHttpRequest(state, request, response);
  });

  server.on("upgrade", (request, socket) => {
    handleUpgrade(state, input, capture, request, socket);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const publicHost = publicHostForUrl(host);
  state.accessUrl = `http://${publicHost}:${port}`;

  input.start();
  capture.start();
  await printStartup(state);

  const shutdown = () => {
    console.log("\nStopping MacMirror...");
    capture.stop();
    input.stop();
    for (const client of state.clients.values()) {
      client.socket.destroy();
    }
    server.close(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main();
