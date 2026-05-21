import AppKit

struct IconVariant {
  let name: String
  let pixels: Int
}

let variants = [
  IconVariant(name: "icon_16x16.png", pixels: 16),
  IconVariant(name: "icon_16x16@2x.png", pixels: 32),
  IconVariant(name: "icon_32x32.png", pixels: 32),
  IconVariant(name: "icon_32x32@2x.png", pixels: 64),
  IconVariant(name: "icon_128x128.png", pixels: 128),
  IconVariant(name: "icon_128x128@2x.png", pixels: 256),
  IconVariant(name: "icon_256x256.png", pixels: 256),
  IconVariant(name: "icon_256x256@2x.png", pixels: 512),
  IconVariant(name: "icon_512x512.png", pixels: 512),
  IconVariant(name: "icon_512x512@2x.png", pixels: 1024)
]

func fail(_ message: String) -> Never {
  fputs("\(message)\n", stderr)
  exit(1)
}

guard CommandLine.arguments.count == 3 else {
  fail("Usage: CreateIconSet <source-png> <output-iconset-dir>")
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)

guard let image = NSImage(contentsOf: sourceURL) else {
  fail("Could not read icon source: \(sourceURL.path)")
}

try FileManager.default.createDirectory(at: outputURL, withIntermediateDirectories: true)

for variant in variants {
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: variant.pixels,
    pixelsHigh: variant.pixels,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    fail("Could not create bitmap for \(variant.name)")
  }

  let size = CGFloat(variant.pixels)
  bitmap.size = NSSize(width: size, height: size)

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
  NSColor.clear.setFill()
  NSRect(x: 0, y: 0, width: size, height: size).fill()
  image.draw(
    in: NSRect(x: 0, y: 0, width: size, height: size),
    from: .zero,
    operation: .sourceOver,
    fraction: 1
  )
  NSGraphicsContext.restoreGraphicsState()

  guard let data = bitmap.representation(using: .png, properties: [:]) else {
    fail("Could not encode \(variant.name)")
  }

  try data.write(to: outputURL.appendingPathComponent(variant.name))
}
