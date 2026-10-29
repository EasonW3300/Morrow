// Morrow 真机门禁项：麦克风捕获探针（T10 / Issue #11，PRD §8 AC-11 前置）。
//
// 用法（CLT swift 直接跑，无需 Xcode 工程）：
//   swift scripts/real-machine/mic-probe.swift [--timeout <secs>]
//
// 行为：
//   1. 列出音频输入设备（AVCaptureDeviceDiscoverySession / devices(for: .audio)）；
//   2. 检查/请求麦克风权限（TCC kTCCServiceMicrophone）：
//      - 未决 → 弹系统授权框，等待最多 --timeout 秒（默认 60s）；
//      - 拒绝/超时 → 如实上报，退出码 2 / 3（不伪造通过）；
//   3. 授权后用 AVAudioEngine input tap 请求级捕获 1 秒，报告采样帧数。
//
// 末行输出单行 JSON（与打包探针同风格）：
//   {"probe":"mic-capture","status":"pass","devices":[...],"sample_rate":48000,
//    "channels":1,"frames_captured":48000,"duration_sec":1.0}
//   status ∈ pass | denied | prompt-timeout | error
//
// 退出码：0 = pass；1 = error（含零采样）；2 = denied；3 = prompt-timeout。
// 注意：从终端运行时 TCC 授权挂在宿主 App（Terminal/iTerm/ZCode）名下；授权一次后
// 探针即可重复执行。M0 门禁口径：探针 pass = 设备可捕获 ≥1 秒真实采样。

import AVFoundation
import Foundation

// MARK: - 工具

/// tap 闭包与主线程并发的帧计数器（NSLock 保证）。
final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int64 = 0
    func add(_ n: Int64) { lock.lock(); value += n; lock.unlock() }
    var current: Int64 { lock.lock(); defer { lock.unlock() }; return value }
}

func jsonEscape(_ s: String) -> String {
    var out = ""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if ch.value < 0x20 { out += String(format: "\\u%04x", ch.value) }
            else { out.unicodeScalars.append(ch) }
        }
    }
    return out
}

/// 末行单行 JSON 报告（布尔/数字直接内插，字符串调用方自带引号）。
func emit(_ status: String, _ fields: [String: String]) {
    var parts = ["\"probe\":\"mic-capture\"", "\"status\":\"\(status)\""]
    for (k, v) in fields { parts.append("\"\(k)\":\(v)") }
    print("{" + parts.joined(separator: ",") + "}")
    FileHandle.standardOutput.synchronizeFile()
}

func fail(_ code: Int32, _ status: String, _ fields: [String: String]) -> Never {
    emit(status, fields)
    exit(code)
}

// MARK: - 参数

var timeoutSecs = 60.0
var args = Array(CommandLine.arguments.dropFirst())
while let i = args.firstIndex(of: "--timeout"), args.count > i + 1 {
    if let t = Double(args[i + 1]) { timeoutSecs = t }
    args.removeSubrange(i..<min(i + 2, args.count))
}

// MARK: - 1. 输入设备清单

let discovery = AVCaptureDevice.DiscoverySession(
    deviceTypes: [.builtInMicrophone, .external],
    mediaType: .audio,
    position: .unspecified)
let devices = discovery.devices
let deviceList = devices.map {
    "{\"name\":\"\(jsonEscape($0.localizedName))\",\"unique_id\":\"\(jsonEscape($0.uniqueID))\"}"
}
let devicesJson = "[\(deviceList.joined(separator: ","))]"
print("mic-probe: 输入设备 \(devices.count) 个：\(devices.map(\.localizedName).joined(separator: "; "))")

// MARK: - 2. 麦克风权限（TCC）

switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized:
    print("mic-probe: 麦克风权限已授予")
case .notDetermined:
    print("mic-probe: 麦克风权限未决 → 请求授权（等待 \(Int(timeoutSecs))s）")
    let sem = DispatchSemaphore(value: 0)
    final class Box: @unchecked Sendable { var granted = false }
    let box = Box()
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        box.granted = granted
        sem.signal()
    }
    if sem.wait(timeout: .now() + timeoutSecs) == .timedOut {
        fail(3, "prompt-timeout", [
            "devices": devicesJson,
            "reason": "\"TCC authorization prompt not answered within \(Int(timeoutSecs))s; requires owner manual grant once\"",
        ])
    }
    if !box.granted {
        fail(2, "denied", ["devices": devicesJson, "reason": "\"owner denied microphone access at prompt\""])
    }
    print("mic-probe: 授权通过")
case .denied, .restricted:
    fail(2, "denied", ["devices": devicesJson, "reason": "\"microphone permission previously denied in System Settings; requires owner manual grant\""])
@unknown default:
    fail(1, "error", ["devices": devicesJson, "reason": "\"unknown authorization status\""])
}

// MARK: - 3. 请求级捕获 1 秒

let engine = AVAudioEngine()
let input = engine.inputNode
let hwFormat = input.outputFormat(forBus: 0)
let format: AVAudioFormat
if hwFormat.sampleRate > 0 {
    format = hwFormat
} else if let fallback = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1) {
    format = fallback
} else {
    fail(1, "error", ["devices": devicesJson, "reason": "\"no usable input format\""])
}
let counter = LockedCounter()

input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
    counter.add(Int64(buffer.frameLength))
}
engine.prepare()
do {
    try engine.start()
} catch {
    fail(1, "error", [
        "devices": devicesJson,
        "reason": "\"engine.start() failed: \(jsonEscape(String(describing: error)))\"",
    ])
}
Thread.sleep(forTimeInterval: 1.0)
engine.stop()
input.removeTap(onBus: 0)

let frames = counter.current
let sampleRate = Int(format.sampleRate)
print("mic-probe: 捕获 1.0s @ \(sampleRate)Hz × \(format.channelCount)ch → \(frames) 帧")
if frames == 0 {
    fail(1, "error", [
        "devices": devicesJson,
        "sample_rate": "\(sampleRate)",
        "channels": "\(format.channelCount)",
        "frames_captured": "0",
        "duration_sec": "1.0",
        "reason": "\"capture ran but zero samples arrived\"",
    ])
}
emit("pass", [
    "devices": devicesJson,
    "sample_rate": "\(sampleRate)",
    "channels": "\(format.channelCount)",
    "frames_captured": "\(frames)",
    "duration_sec": "1.0",
])
exit(0)
