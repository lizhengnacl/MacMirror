import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct CaptureOptions {
    var fps: Double = 20
    var maxHeight: Int = 1080
    var quality: Double = 0.60
}

func parseOptions() -> CaptureOptions {
    var options = CaptureOptions()
    var index = 1
    let args = CommandLine.arguments

    while index < args.count {
        let arg = args[index]
        if arg == "--fps", index + 1 < args.count {
            options.fps = Double(args[index + 1]) ?? options.fps
            index += 2
        } else if arg == "--max-height", index + 1 < args.count {
            options.maxHeight = Int(args[index + 1]) ?? options.maxHeight
            index += 2
        } else if arg == "--quality", index + 1 < args.count {
            options.quality = Double(args[index + 1]) ?? options.quality
            index += 2
        } else {
            index += 1
        }
    }

    options.fps = max(1, min(options.fps, 60))
    options.quality = max(0.1, min(options.quality, 0.95))
    return options
}

func writeUInt32(_ value: UInt32, to output: FileHandle) {
    var bigEndian = value.bigEndian
    let data = Data(bytes: &bigEndian, count: MemoryLayout<UInt32>.size)
    output.write(data)
}

func resizedImage(_ image: CGImage, maxHeight: Int) -> (CGImage, Int, Int)? {
    let sourceWidth = image.width
    let sourceHeight = image.height

    if maxHeight <= 0 || sourceHeight <= maxHeight {
        return (image, sourceWidth, sourceHeight)
    }

    let scale = Double(maxHeight) / Double(sourceHeight)
    let targetWidth = max(1, Int(Double(sourceWidth) * scale))
    let targetHeight = max(1, Int(Double(sourceHeight) * scale))
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.noneSkipFirst.rawValue

    guard let context = CGContext(
        data: nil,
        width: targetWidth,
        height: targetHeight,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else {
        return nil
    }

    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))

    guard let output = context.makeImage() else {
        return nil
    }
    return (output, targetWidth, targetHeight)
}

func jpegData(for image: CGImage, quality: Double) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
        data,
        UTType.jpeg.identifier as CFString,
        1,
        nil
    ) else {
        return nil
    }

    let properties: [CFString: Any] = [
        kCGImageDestinationLossyCompressionQuality: quality
    ]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)

    guard CGImageDestinationFinalize(destination) else {
        return nil
    }
    return data as Data
}

func frameStats(for image: CGImage) -> (averageLuma: Double, darkRatio: Double)? {
    let sampleWidth = 32
    let aspect = Double(image.height) / max(1.0, Double(image.width))
    let sampleHeight = max(8, min(32, Int(Double(sampleWidth) * aspect)))
    let bytesPerPixel = 4
    let bytesPerRow = sampleWidth * bytesPerPixel
    var pixels = [UInt8](repeating: 0, count: sampleHeight * bytesPerRow)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue

    return pixels.withUnsafeMutableBytes { rawBuffer in
        guard let baseAddress = rawBuffer.baseAddress,
              let context = CGContext(
                data: baseAddress,
                width: sampleWidth,
                height: sampleHeight,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: colorSpace,
                bitmapInfo: bitmapInfo
              ) else {
            return nil
        }

        context.interpolationQuality = .low
        context.draw(image, in: CGRect(x: 0, y: 0, width: sampleWidth, height: sampleHeight))

        let bytes = rawBuffer.bindMemory(to: UInt8.self)
        var lumaTotal = 0.0
        var darkPixels = 0
        let pixelCount = sampleWidth * sampleHeight

        for index in stride(from: 0, to: bytes.count, by: bytesPerPixel) {
            let red = Double(bytes[index])
            let green = Double(bytes[index + 1])
            let blue = Double(bytes[index + 2])
            let luma = red * 0.2126 + green * 0.7152 + blue * 0.0722
            lumaTotal += luma
            if luma < 3.0 {
                darkPixels += 1
            }
        }

        return (
            averageLuma: lumaTotal / Double(pixelCount),
            darkRatio: Double(darkPixels) / Double(pixelCount)
        )
    }
}

let options = parseOptions()
let output = FileHandle.standardOutput
let displayID = CGMainDisplayID()
let displayBounds = CGDisplayBounds(displayID)
let interval = 1.0 / options.fps
let statsInterval = max(1, Int(options.fps))
var frameIndex = 0
var lastAverageLuma = 32.0
var lastDarkRatio = 0.0
var lastBlankFrame = false

if !CGPreflightScreenCaptureAccess() {
    FileHandle.standardError.write(Data("Screen Recording permission is not granted. Approve the macOS prompt, then restart MacMirror if frames stay black.\n".utf8))
    _ = CGRequestScreenCaptureAccess()
}

while true {
    let startedAt = Date()
    frameIndex += 1

    guard let captured = CGDisplayCreateImage(displayID) else {
        FileHandle.standardError.write(Data("Unable to capture the main display. Check Screen Recording permission.\n".utf8))
        Thread.sleep(forTimeInterval: 1.0)
        continue
    }

    guard let (image, frameWidth, frameHeight) = resizedImage(captured, maxHeight: options.maxHeight),
          let jpeg = jpegData(for: image, quality: options.quality) else {
        FileHandle.standardError.write(Data("Unable to encode JPEG frame.\n".utf8))
        Thread.sleep(forTimeInterval: interval)
        continue
    }

    if frameIndex == 1 || frameIndex % statsInterval == 0 {
        let stats = frameStats(for: image)
        lastAverageLuma = stats?.averageLuma ?? lastAverageLuma
        lastDarkRatio = stats?.darkRatio ?? lastDarkRatio
        lastBlankFrame = lastAverageLuma < 1.5 && lastDarkRatio > 0.995
    }

    let metadata: [String: Any] = [
        "frameWidth": frameWidth,
        "frameHeight": frameHeight,
        "screenWidth": displayBounds.width,
        "screenHeight": displayBounds.height,
        "averageLuma": lastAverageLuma,
        "darkRatio": lastDarkRatio,
        "blankFrame": lastBlankFrame,
        "timestamp": Int(Date().timeIntervalSince1970 * 1000)
    ]

    guard let metaData = try? JSONSerialization.data(withJSONObject: metadata) else {
        continue
    }

    writeUInt32(UInt32(metaData.count), to: output)
    output.write(metaData)
    writeUInt32(UInt32(jpeg.count), to: output)
    output.write(jpeg)

    let elapsed = Date().timeIntervalSince(startedAt)
    if elapsed < interval {
        Thread.sleep(forTimeInterval: interval - elapsed)
    }
}
