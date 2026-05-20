# MacMirror

MacMirror is a tiny local macOS screen mirror for phone browsers. Start one
command on the Mac, open the LAN URL on a phone, then view and perform simple
mouse actions on the main display.

The current implementation uses the long-term capture/encode path:

- ScreenCaptureKit for macOS display capture
- VideoToolbox hardware H.264 encoding
- WebRTC media transport with H.264 RTP
- RTCDataChannel for pointer input
- WebSocket only for SDP/ICE signaling and status messages

The browser renders the remote screen through a native `<video>` element. The
Node service uses `werift` as the WebRTC stack and forwards VideoToolbox Annex-B
H.264 as RFC 6184 RTP packets.

## Requirements

- macOS 12.3+
- Node.js 18+
- Swift command line tools
- A browser with WebRTC H.264 support
- Phone and Mac on the same LAN

For local development, Chrome on `http://127.0.0.1` is the most predictable test
target. LAN phone browsers should use the printed LAN URL or QR code.

macOS permissions are required:

- Screen Recording for live capture
- Accessibility for mouse control

If the stream is black or input does nothing, grant those permissions to the
terminal application that starts MacMirror, then restart the service.

On macOS this is usually:

- System Settings -> Privacy & Security -> Screen Recording
- System Settings -> Privacy & Security -> Accessibility

Grant access to Terminal, iTerm, VS Code, or whichever app started `npm start`.
If a browser page says `Captured black frames`, signaling is connected but
macOS is still returning blank screen data to the capture helper.

## Local Preview Feedback

If you open MacMirror in a browser on the same Mac display that is being
captured, the page will mirror itself and produce a nested image. This is normal
screen feedback. Open the URL on a phone or another device for real use, or move
the desktop browser off the captured main display while testing.

## Phone Viewing

The phone page includes a landscape button that tries to enter fullscreen and
lock the browser to landscape. Browsers that do not allow orientation locking
can still be rotated manually. If MacMirror is added to the home screen, its web
app manifest asks the launcher to open it in landscape fullscreen mode.

## Start

```sh
npm start
```

Options:

```sh
npm start -- --port 8080
npm start -- --host 192.168.1.10
npm start -- --quality smooth
```

Quality modes:

- `smooth`: 720p target, 30 fps, 2.5 Mbps
- `balanced`: 1080p target, 30 fps, 5 Mbps
- `high`: native display size, 30 fps, 8 Mbps

The WebRTC sender uses constrained-baseline H.264 and requests a fresh key frame
when the browser sends PLI. Internally, the native helper sends frames to Node
as JSONL/base64 packets; this is only local IPC and does not affect the browser
transport.

The terminal prints the local URL and an ASCII QR code. Stop with `Ctrl+C`.

## Notes

- The service binds to the first private LAN IPv4 address by default. Use
  `--host 0.0.0.0` only when you explicitly want all interfaces.
- Multiple viewers are allowed. The first connected client owns control; other
  clients can still watch.
- `native/MacMirrorCapture.swift` is retained as the old JPEG helper, but the
  default service path is `native/MacMirrorH264Capture.swift`.
