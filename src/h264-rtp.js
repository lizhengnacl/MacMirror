import crypto from "node:crypto";
import { RtpHeader, RtpPacket } from "werift";

const DEFAULT_MAX_PAYLOAD_BYTES = 1200;
const H264_CLOCK_RATE = 90_000;
const MICROSECONDS_PER_SECOND = 1_000_000;
const UINT16_MOD = 0x10000;

export function createH264RtpState() {
  return {
    sequenceNumber: crypto.randomInt(0, UINT16_MOD),
    timestampBase: crypto.randomBytes(4).readUInt32BE(0),
    firstCaptureTimestampUs: null
  };
}

export function packetizeAnnexBFrame(frame, meta, state, options = {}) {
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const timestamp = rtpTimestamp(meta, state);
  const payloads = [];

  for (const nalu of splitAnnexBNalus(frame)) {
    if (nalu.length === 0) {
      continue;
    }
    payloads.push(...packetizeNalu(nalu, maxPayloadBytes));
  }

  return payloads.map((payload, index) => {
    const packet = new RtpPacket(
      new RtpHeader({
        marker: index === payloads.length - 1,
        payloadType: 96,
        sequenceNumber: state.sequenceNumber,
        timestamp
      }),
      payload
    );
    state.sequenceNumber = (state.sequenceNumber + 1) % UINT16_MOD;
    return packet;
  });
}

function rtpTimestamp(meta, state) {
  const captureTimestampUs = Number(meta?.timestamp);
  if (!Number.isFinite(captureTimestampUs)) {
    return state.timestampBase >>> 0;
  }

  if (state.firstCaptureTimestampUs === null) {
    state.firstCaptureTimestampUs = captureTimestampUs;
  }

  const elapsedUs = Math.max(0, captureTimestampUs - state.firstCaptureTimestampUs);
  const elapsedRtpTicks = Math.round(elapsedUs * H264_CLOCK_RATE / MICROSECONDS_PER_SECOND);
  return (state.timestampBase + elapsedRtpTicks) >>> 0;
}

function packetizeNalu(nalu, maxPayloadBytes) {
  if (nalu.length <= maxPayloadBytes) {
    return [nalu];
  }

  const naluHeader = nalu[0];
  const forbiddenAndNri = naluHeader & 0xe0;
  const naluType = naluHeader & 0x1f;
  const fuIndicator = forbiddenAndNri | 28;
  const maxFragmentBytes = maxPayloadBytes - 2;
  const payloads = [];

  for (let offset = 1; offset < nalu.length; offset += maxFragmentBytes) {
    const end = Math.min(offset + maxFragmentBytes, nalu.length);
    const startBit = offset === 1 ? 0x80 : 0x00;
    const endBit = end === nalu.length ? 0x40 : 0x00;
    const fuHeader = startBit | endBit | naluType;
    payloads.push(Buffer.concat([
      Buffer.from([fuIndicator, fuHeader]),
      nalu.subarray(offset, end)
    ]));
  }

  return payloads;
}

function splitAnnexBNalus(frame) {
  const ranges = [];
  let startCode = findStartCode(frame, 0);

  if (startCode === null) {
    return [frame];
  }

  while (startCode !== null) {
    const naluStart = startCode.index + startCode.length;
    const nextStartCode = findStartCode(frame, naluStart);
    const naluEnd = nextStartCode?.index ?? frame.length;
    if (naluEnd > naluStart) {
      ranges.push(frame.subarray(naluStart, naluEnd));
    }
    startCode = nextStartCode;
  }

  return ranges;
}

function findStartCode(buffer, from) {
  for (let index = from; index <= buffer.length - 3; index += 1) {
    if (buffer[index] !== 0x00 || buffer[index + 1] !== 0x00) {
      continue;
    }
    if (buffer[index + 2] === 0x01) {
      return { index, length: 3 };
    }
    if (index <= buffer.length - 4 && buffer[index + 2] === 0x00 && buffer[index + 3] === 0x01) {
      return { index, length: 4 };
    }
  }
  return null;
}
