import CoreGraphics
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit
import VideoToolbox

struct CaptureOptions {
    var fps: Int32 = 30
    var maxHeight: Int = 1080
    var bitrate: Int = 5_000_000
}

func parseOptions() -> CaptureOptions {
    var options = CaptureOptions()
    var index = 1
    let args = CommandLine.arguments

    while index < args.count {
        let arg = args[index]
        if arg == "--fps", index + 1 < args.count {
            options.fps = Int32(args[index + 1]) ?? options.fps
            index += 2
        } else if arg == "--max-height", index + 1 < args.count {
            options.maxHeight = Int(args[index + 1]) ?? options.maxHeight
            index += 2
        } else if arg == "--bitrate", index + 1 < args.count {
            options.bitrate = Int(args[index + 1]) ?? options.bitrate
            index += 2
        } else {
            index += 1
        }
    }

    options.fps = max(1, min(options.fps, 60))
    options.bitrate = max(250_000, options.bitrate)
    return options
}

func writePacket(meta: [String: Any], payload: Data, to _: FileHandle) {
    var envelope = meta
    envelope["payload"] = payload.base64EncodedString()

    guard var packet = try? JSONSerialization.data(withJSONObject: envelope) else {
        return
    }
    packet.append(0x0a)
    writeAll(packet, to: STDOUT_FILENO)
}

func writeAll(_ data: Data, to fileDescriptor: Int32) {
    data.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.baseAddress else {
            return
        }

        var offset = 0
        while offset < rawBuffer.count {
            let chunkLength = min(4_096, rawBuffer.count - offset)
            let written = Darwin.write(
                fileDescriptor,
                baseAddress.advanced(by: offset),
                chunkLength
            )
            if written < 0 {
                if errno == EPIPE || errno == EBADF {
                    return
                }
                usleep(1_000)
                continue
            }
            if written == 0 {
                usleep(1_000)
                continue
            }
            offset += written
        }
    }
}

func fourCC(_ value: OSType) -> String {
    let chars = [
        UInt8((value >> 24) & 0xff),
        UInt8((value >> 16) & 0xff),
        UInt8((value >> 8) & 0xff),
        UInt8(value & 0xff)
    ]
    return String(bytes: chars, encoding: .ascii) ?? "\(value)"
}

func codecString(profileIDC: UInt8, compatibility: UInt8, levelIDC: UInt8) -> String {
    return String(format: "avc1.%02X%02X%02X", profileIDC, compatibility, levelIDC)
}

func annexBParameterSets(from formatDescription: CMFormatDescription) -> (data: Data, codec: String)? {
    var spsPointer: UnsafePointer<UInt8>?
    var ppsPointer: UnsafePointer<UInt8>?
    var spsSize = 0
    var ppsSize = 0
    var parameterSetCount = 0
    var nalUnitHeaderLength: Int32 = 0

    let spsStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        formatDescription,
        parameterSetIndex: 0,
        parameterSetPointerOut: &spsPointer,
        parameterSetSizeOut: &spsSize,
        parameterSetCountOut: &parameterSetCount,
        nalUnitHeaderLengthOut: &nalUnitHeaderLength
    )
    let ppsStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        formatDescription,
        parameterSetIndex: 1,
        parameterSetPointerOut: &ppsPointer,
        parameterSetSizeOut: &ppsSize,
        parameterSetCountOut: &parameterSetCount,
        nalUnitHeaderLengthOut: &nalUnitHeaderLength
    )

    guard spsStatus == noErr,
          ppsStatus == noErr,
          let spsPointer,
          let ppsPointer,
          spsSize >= 4 else {
        return nil
    }

    var data = Data()
    data.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
    data.append(spsPointer, count: spsSize)
    data.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
    data.append(ppsPointer, count: ppsSize)

    let codec = codecString(
        profileIDC: spsPointer[1],
        compatibility: spsPointer[2],
        levelIDC: spsPointer[3]
    )

    return (data, codec)
}

func annexBFrame(from sampleBuffer: CMSampleBuffer, includeParameterSets: Bool) -> (data: Data, codec: String?)? {
    guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else {
        return nil
    }

    var lengthAtOffset = 0
    var totalLength = 0
    var dataPointer: UnsafeMutablePointer<Int8>?
    let pointerStatus = CMBlockBufferGetDataPointer(
        blockBuffer,
        atOffset: 0,
        lengthAtOffsetOut: &lengthAtOffset,
        totalLengthOut: &totalLength,
        dataPointerOut: &dataPointer
    )

    guard pointerStatus == kCMBlockBufferNoErr, let dataPointer else {
        return nil
    }

    var output = Data()
    var codec: String?

    if includeParameterSets,
       let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
       let parameterSets = annexBParameterSets(from: formatDescription) {
        output.append(parameterSets.data)
        codec = parameterSets.codec
    }

    var offset = 0
    let nalLengthHeaderSize = 4
    while offset + nalLengthHeaderSize <= totalLength {
        var nalLength: UInt32 = 0
        memcpy(&nalLength, dataPointer.advanced(by: offset), nalLengthHeaderSize)
        nalLength = UInt32(bigEndian: nalLength)
        offset += nalLengthHeaderSize

        let length = Int(nalLength)
        guard length > 0, offset + length <= totalLength else {
            break
        }

        output.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
        output.append(UnsafeRawPointer(dataPointer.advanced(by: offset)).assumingMemoryBound(to: UInt8.self), count: length)
        offset += length
    }

    return (output, codec)
}

func isKeyFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
        sampleBuffer,
        createIfNecessary: false
    ) as? [[CFString: Any]], let first = attachments.first else {
        return true
    }

    return first[kCMSampleAttachmentKey_NotSync] == nil
}

final class H264Encoder: @unchecked Sendable {
    private let output = FileHandle.standardOutput
    private let options: CaptureOptions
    private var session: VTCompressionSession?
    private var width = 0
    private var height = 0
    private var sequence: UInt64 = 0
    private var codec = "avc1.42E01F"
    private let lock = NSLock()
    private let outputLock = NSLock()
    private let keyFrameLock = NSLock()
    private var forceKeyFrame = false

    init(options: CaptureOptions) {
        self.options = options
    }

    func invalidate() {
        lock.lock()
        let activeSession = session
        session = nil
        lock.unlock()

        if let activeSession {
            VTCompressionSessionCompleteFrames(activeSession, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(activeSession)
        }
    }

    func requestKeyFrame() {
        keyFrameLock.lock()
        forceKeyFrame = true
        keyFrameLock.unlock()
    }

    func encode(sampleBuffer: CMSampleBuffer) {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return
        }

        let frameWidth = CVPixelBufferGetWidth(imageBuffer)
        let frameHeight = CVPixelBufferGetHeight(imageBuffer)

        if session == nil || frameWidth != width || frameHeight != height {
            configure(width: frameWidth, height: frameHeight)
        }

        guard let session else {
            return
        }

        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let duration = CMTime(value: 1, timescale: options.fps)
        let frameProperties = takeForceKeyFrame()
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
            : nil
        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: imageBuffer,
            presentationTimeStamp: timestamp,
            duration: duration,
            frameProperties: frameProperties,
            sourceFrameRefcon: nil,
            infoFlagsOut: nil
        )
    }

    private func takeForceKeyFrame() -> Bool {
        keyFrameLock.lock()
        let shouldForce = forceKeyFrame
        forceKeyFrame = false
        keyFrameLock.unlock()
        return shouldForce
    }

    private func configure(width: Int, height: Int) {
        invalidate()
        self.width = width
        self.height = height

        let callback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
            guard status == noErr,
                  let refcon,
                  let sampleBuffer,
                  CMSampleBufferDataIsReady(sampleBuffer) else {
                return
            }

            let encoder = Unmanaged<H264Encoder>.fromOpaque(refcon).takeUnretainedValue()
            encoder.handleEncoded(sampleBuffer)
        }

        var newSession: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: [
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true
            ] as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: callback,
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &newSession
        )

        guard status == noErr, let newSession else {
            FileHandle.standardError.write(Data("Unable to create H.264 encoder: \(status)\n".utf8))
            return
        }

        var fpsValue = options.fps
        var keyFrameInterval = options.fps * 2
        var bitrateValue = options.bitrate
        let dataRateLimits = [
            options.bitrate / 8,
            1
        ] as CFArray

        VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel)
        VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: CFNumberCreate(nil, .sInt32Type, &fpsValue))
        VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: CFNumberCreate(nil, .sInt32Type, &keyFrameInterval))
        VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_AverageBitRate, value: CFNumberCreate(nil, .sInt32Type, &bitrateValue))
        VTSessionSetProperty(newSession, key: kVTCompressionPropertyKey_DataRateLimits, value: dataRateLimits)
        VTCompressionSessionPrepareToEncodeFrames(newSession)

        lock.lock()
        session = newSession
        lock.unlock()
    }

    private func handleEncoded(_ sampleBuffer: CMSampleBuffer) {
        let keyFrame = isKeyFrame(sampleBuffer)
        guard let frame = annexBFrame(from: sampleBuffer, includeParameterSets: keyFrame) else {
            return
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let timestamp = pts.isValid ? Int64(CMTimeGetSeconds(pts) * 1_000_000) : Int64(Date().timeIntervalSince1970 * 1_000_000)

        outputLock.lock()
        defer { outputLock.unlock() }

        if let nextCodec = frame.codec {
            codec = nextCodec
        }

        sequence += 1
        let meta: [String: Any] = [
            "codec": "h264",
            "codecString": codec,
            "bitstream": "annexb",
            "frameWidth": width,
            "frameHeight": height,
            "screenWidth": width,
            "screenHeight": height,
            "keyFrame": keyFrame,
            "sequence": sequence,
            "timestamp": timestamp,
            "blankFrame": false
        ]

        writePacket(meta: meta, payload: frame.data, to: output)
    }
}

@available(macOS 12.3, *)
final class ScreenCaptureOutput: NSObject, SCStreamOutput {
    private let encoder: H264Encoder

    init(encoder: H264Encoder) {
        self.encoder = encoder
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen,
              sampleBuffer.isValid else {
            return
        }

        encoder.encode(sampleBuffer: sampleBuffer)
    }
}

@available(macOS 12.3, *)
func startCapture(options: CaptureOptions) async throws {
    if !CGPreflightScreenCaptureAccess() {
        FileHandle.standardError.write(Data("Screen Recording permission is not granted. Approve the macOS prompt, then restart MacMirror if frames stay black.\n".utf8))
        _ = CGRequestScreenCaptureAccess()
    }

    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let mainDisplayID = CGMainDisplayID()
    guard let display = content.displays.first(where: { $0.displayID == mainDisplayID }) ?? content.displays.first else {
        throw NSError(domain: "MacMirror", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "No capturable display found."
        ])
    }

    let sourceWidth = display.width
    let sourceHeight = display.height
    let scale = options.maxHeight > 0 && sourceHeight > options.maxHeight
        ? Double(options.maxHeight) / Double(sourceHeight)
        : 1.0
    let targetWidth = max(2, Int(Double(sourceWidth) * scale) / 2 * 2)
    let targetHeight = max(2, Int(Double(sourceHeight) * scale) / 2 * 2)

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.width = targetWidth
    configuration.height = targetHeight
    configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
    configuration.queueDepth = 3
    configuration.showsCursor = true

    let encoder = H264Encoder(options: options)
    let output = ScreenCaptureOutput(encoder: encoder)
    DispatchQueue.global(qos: .utility).async {
        while let line = readLine() {
            if line.trimmingCharacters(in: .whitespacesAndNewlines) == "keyframe" {
                encoder.requestKeyFrame()
            }
        }
    }

    let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "macmirror.capture.screen"))
    try await stream.startCapture()

    FileHandle.standardError.write(Data("ScreenCaptureKit H.264 stream started: \(targetWidth)x\(targetHeight) @ \(options.fps)fps, bitrate \(options.bitrate).\n".utf8))
    while true {
        try await Task.sleep(nanoseconds: 3_600_000_000_000)
    }
}

let options = parseOptions()

if #available(macOS 12.3, *) {
    Task {
        do {
            try await startCapture(options: options)
        } catch {
            FileHandle.standardError.write(Data("Unable to start ScreenCaptureKit capture: \(error.localizedDescription)\n".utf8))
            exit(2)
        }
    }
    RunLoop.main.run()
} else {
    FileHandle.standardError.write(Data("ScreenCaptureKit requires macOS 12.3 or newer.\n".utf8))
    exit(2)
}
