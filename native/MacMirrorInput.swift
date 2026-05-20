import CoreGraphics
import Foundation

func pointFromNormalized(_ x: Double, _ y: Double) -> CGPoint {
    let displayID = CGMainDisplayID()
    let bounds = CGDisplayBounds(displayID)
    let clampedX = max(0.0, min(1.0, x))
    let clampedY = max(0.0, min(1.0, y))

    return CGPoint(
        x: bounds.origin.x + bounds.width * clampedX,
        y: bounds.origin.y + bounds.height * clampedY
    )
}

func postMove(to point: CGPoint) {
    CGEvent(
        mouseEventSource: nil,
        mouseType: .mouseMoved,
        mouseCursorPosition: point,
        mouseButton: .left
    )?.post(tap: .cghidEventTap)
}

func postClick(to point: CGPoint, button: CGMouseButton, down: CGEventType, up: CGEventType) {
    postMove(to: point)
    CGEvent(
        mouseEventSource: nil,
        mouseType: down,
        mouseCursorPosition: point,
        mouseButton: button
    )?.post(tap: .cghidEventTap)
    CGEvent(
        mouseEventSource: nil,
        mouseType: up,
        mouseCursorPosition: point,
        mouseButton: button
    )?.post(tap: .cghidEventTap)
}

func postScroll(dx: Double, dy: Double) {
    let clampedX = Int32(max(-2000.0, min(2000.0, dx)))
    let clampedY = Int32(max(-2000.0, min(2000.0, dy)))
    CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 2,
        wheel1: clampedY,
        wheel2: clampedX,
        wheel3: 0
    )?.post(tap: .cghidEventTap)
}

while let line = readLine() {
    let parts = line.split(separator: " ")
    guard let command = parts.first else {
        continue
    }

    if command == "scroll", parts.count >= 3 {
        let dx = Double(parts[1]) ?? 0
        let dy = Double(parts[2]) ?? 0
        postScroll(dx: dx, dy: dy)
    } else if parts.count >= 3 {
        let x = Double(parts[1]) ?? 0
        let y = Double(parts[2]) ?? 0
        let point = pointFromNormalized(x, y)

        if command == "move" {
            postMove(to: point)
        } else if command == "click" {
            postClick(to: point, button: .left, down: .leftMouseDown, up: .leftMouseUp)
        } else if command == "right-click" {
            postClick(to: point, button: .right, down: .rightMouseDown, up: .rightMouseUp)
        }
    }
}
