// FX Practice のアイコン（1024px の PNG）を描く。make-app.sh が呼んで .icns にする。
//   swift icon.swift <出力先.png>
// 暗い角丸の四角に、ローソク足 3 本（陽線・陰線・陽線。FP のローソク足の色）と、右上がりの移動平均の線

import AppKit

let size = 1024.0
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext

// 背景（macOS のアイコンの余白と角丸に合わせる）
let inset = 100.0
let bg = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
ctx.addPath(CGPath(roundedRect: bg, cornerWidth: 185, cornerHeight: 185, transform: nil))
ctx.clip()
let colors = [CGColor(red: 0.09, green: 0.11, blue: 0.14, alpha: 1), CGColor(red: 0.03, green: 0.04, blue: 0.06, alpha: 1)] as CFArray
let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size - inset), end: CGPoint(x: 0, y: inset), options: [])

let up = CGColor(red: 0xa5 / 255, green: 0xd6 / 255, blue: 0xa7 / 255, alpha: 1)
let down = CGColor(red: 0xde / 255, green: 0x7a / 255, blue: 0x7a / 255, alpha: 1)

/// ローソク足 1 本（x は真ん中、値は下からの高さ）
func candle(_ x: Double, low: Double, open: Double, close: Double, high: Double) {
  let color = close >= open ? up : down
  ctx.setFillColor(color)
  ctx.fill(CGRect(x: x - 9, y: low, width: 18, height: high - low))
  ctx.fill(CGRect(x: x - 62, y: min(open, close), width: 124, height: abs(close - open)))
}

candle(330, low: 300, open: 390, close: 560, high: 640)
candle(512, low: 380, open: 640, close: 470, high: 700)
candle(694, low: 430, open: 520, close: 760, high: 830)

// 移動平均（右上がり。FP の青）
ctx.setStrokeColor(CGColor(red: 0x44 / 255, green: 0x93 / 255, blue: 0xf8 / 255, alpha: 1))
ctx.setLineWidth(22)
ctx.setLineCap(.round)
ctx.move(to: CGPoint(x: 210, y: 360))
ctx.addCurve(to: CGPoint(x: 820, y: 700), control1: CGPoint(x: 420, y: 380), control2: CGPoint(x: 600, y: 640))
ctx.strokePath()

img.unlockFocus()
let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
