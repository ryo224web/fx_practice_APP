// FX Practice の専用アプリ（Mac mini）。npm run make-app で ~/Applications/FX Practice.app に作る。
//
// - 開くと開発サーバー（vite、5173 番）を起動し、動き出したら自分のウィンドウに FP を出す（WebKit = Safari と同じ部品）。
//   サーバーがもう動いていれば（npm run dev やブラウザで使っていたとき）、それをそのまま使う
// - 閉じる・終了するときは、書きかけの保存（window.__fxpFlush）を済ませてから、自分で起動したサーバーだけを止める
// - FP の確認（confirm）・名前の入力（prompt）・ファイルを選ぶ画面・書き出し（CSV・レポート・プロジェクト）を Mac の画面で出す
// - ブラウザでも今までどおり http://localhost:5173 で使える（サーバーが動いている間）
// - ウィンドウの大きさと位置を覚える。記録は ~/Library/Logs/fx-practice.log
//
// プロジェクトのフォルダは Info.plist の FXPProjectDir（make-app が書く）。
// 動作確認のときだけ、Info.plist の FXPPort（番号。初めは 5173）と FXPViteArgs（vite に足す引数）で別のサーバーにできる。

import AppKit
import WebKit

let info = Bundle.main.infoDictionary ?? [:]
/// 保存データ（localStorage）はアドレスごとに分かれるので、ふだんは必ず 5173
let port = info["FXPPort"] as? String ?? "5173"
let viteArgs = info["FXPViteArgs"] as? String ?? ""
let appURL = URL(string: "http://localhost:\(port)")!
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/fx-practice.log")

/// FP が 5173 番で動いているか（別のアプリが使っているときは false）
func fpRunning() -> Bool {
  var req = URLRequest(url: appURL)
  req.timeoutInterval = 1
  let sem = DispatchSemaphore(value: 0)
  var ok = false
  URLSession.shared.dataTask(with: req) { data, _, _ in
    if let data, let s = String(data: data, encoding: .utf8), s.contains("<title>FX Practice</title>") { ok = true }
    sem.signal()
  }.resume()
  _ = sem.wait(timeout: .now() + 1.5)
  return ok
}

/// 5173 番を何かが使っているか
func portBusy() -> Bool {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
  p.arguments = ["-ti", "tcp:\(port)", "-sTCP:LISTEN"]
  let pipe = Pipe()
  p.standardOutput = pipe
  try? p.run()
  p.waitUntilExit()
  return !(pipe.fileHandleForReading.readDataToEndOfFile().isEmpty)
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var web: WKWebView!
  /// 自分で起動したサーバー（終了するときに止める）。もう動いていたサーバーは止めない
  var server: Process?
  var quitting = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    web = WKWebView(frame: .zero, configuration: config)
    web.uiDelegate = self
    web.navigationDelegate = self
    web.isInspectable = true
    web.allowsMagnification = false

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1600, height: 1000),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "FX Practice"
    window.minSize = NSSize(width: 900, height: 600)
    window.contentView = web
    window.center()
    window.setFrameAutosaveName("FXPracticeMain")
    window.backgroundColor = NSColor(red: 0.05, green: 0.07, blue: 0.09, alpha: 1)
    window.makeKeyAndOrderFront(nil)
    web.loadHTMLString(
      "<body style='background:#0d1117;color:#8d96a0;font:14px -apple-system;display:grid;place-items:center;height:90vh'>FX Practice を起動しています…</body>",
      baseURL: nil)
    NSApp.activate(ignoringOtherApps: true)

    DispatchQueue.global().async {
      let ok = self.startServerIfNeeded()
      DispatchQueue.main.async {
        if ok {
          self.web.load(URLRequest(url: appURL))
        } else {
          self.alert(
            "FX Practice を起動できませんでした",
            self.server == nil && portBusy()
              ? "\(port) 番を別のアプリが使っています。そのアプリを終了してから、もう一度開いてください。"
              : "記録: ~/Library/Logs/fx-practice.log")
          NSApp.terminate(nil)
        }
      }
    }
  }

  /// サーバーが動いていなければ起動して、動き出すまで待つ（最大 20 秒）
  func startServerIfNeeded() -> Bool {
    if fpRunning() { return true }
    if portBusy() { return false }
    let dir = Bundle.main.object(forInfoDictionaryKey: "FXPProjectDir") as? String ?? ""
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    let log = try? FileHandle(forWritingTo: logURL)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-c", "cd \"$FXP_DIR\" && exec npx vite --port \(port) --strictPort \(viteArgs)"]
    var env = ProcessInfo.processInfo.environment
    env["FXP_DIR"] = dir
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
    p.environment = env
    p.standardOutput = log
    p.standardError = log
    do { try p.run() } catch { return false }
    server = p
    for _ in 0..<100 {
      if fpRunning() { return true }
      if !p.isRunning { return false }
      Thread.sleep(forTimeInterval: 0.2)
    }
    return false
  }

  /// 自分で起動したサーバーを止める（npx の下で動く vite も含めて、5173 番で待っているものを止める）
  func stopServer() {
    guard let p = server else { return }
    let kill = Process()
    kill.executableURL = URL(fileURLWithPath: "/bin/zsh")
    kill.arguments = ["-c", "pids=$(lsof -ti tcp:\(port) -sTCP:LISTEN); [ -n \"$pids\" ] && kill $pids"]
    try? kill.run()
    kill.waitUntilExit()
    if p.isRunning { p.terminate() }
    server = nil
  }

  // ---- 終了 ----

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  /// 書きかけの保存を済ませてから終わる（最大 3 秒待つ）
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if quitting || web == nil { return .terminateNow }
    quitting = true
    var done = false
    let finish = {
      if done { return }
      done = true
      self.stopServer()
      NSApp.reply(toApplicationShouldTerminate: true)
    }
    web.callAsyncJavaScript("if (window.__fxpFlush) await window.__fxpFlush();", arguments: [:], in: nil, in: .page) { _ in finish() }
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { finish() }
    return .terminateLater
  }

  // ---- メニュー（コピー・貼り付けなどの ⌘ キーは、メニューが無いと効かない） ----

  func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "FX Practice について", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "FX Practice を隠す", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "FX Practice を終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let edit = NSMenu(title: "編集")
    edit.addItem(withTitle: "取り消す", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "やり直す", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "カット", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "コピー", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "ペースト", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "すべてを選択", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    main.addItem(editItem)

    let viewItem = NSMenuItem()
    let view = NSMenu(title: "表示")
    view.addItem(withTitle: "読み直す", action: #selector(reload), keyEquivalent: "r")
    view.addItem(withTitle: "開発者ツール", action: #selector(inspect), keyEquivalent: "i").keyEquivalentModifierMask = [.command, .option]
    view.addItem(.separator())
    let full = view.addItem(withTitle: "フルスクリーン", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
    full.keyEquivalentModifierMask = [.command, .control]
    viewItem.submenu = view
    main.addItem(viewItem)

    let winItem = NSMenuItem()
    let win = NSMenu(title: "ウインドウ")
    win.addItem(withTitle: "しまう", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    win.addItem(withTitle: "拡大/縮小", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    winItem.submenu = win
    main.addItem(winItem)
    NSApp.mainMenu = main
    NSApp.windowsMenu = win
  }

  @objc func reload() { web.reload() }

  @objc func inspect() {
    // 開発者ツールは、ページを右クリック →「要素の詳細を表示」でも開ける
    alert("開発者ツール", "ページを右クリックして「要素の詳細を表示」を選ぶと開きます。")
  }

  // ---- FP の確認・入力・ファイルの画面 ----

  func alert(_ title: String, _ message: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = message
    a.runModal()
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "キャンセル")
    a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert()
    a.messageText = prompt
    a.addButton(withTitle: "OK")
    a.addButton(withTitle: "キャンセル")
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.window.initialFirstResponder = field
    a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = false
    panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
  }

  /// target="_blank" などで開こうとしたページは、いつものブラウザで開く
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  // ---- 書き出し（<a download>）----

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if navigationAction.shouldPerformDownload { return decisionHandler(.download) }
    // FP 以外のページ（外へのリンク）は、いつものブラウザで開く
    if let url = navigationAction.request.url, navigationAction.navigationType == .linkActivated, url.host != appURL.host {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

  /// 保存先を聞く（初めは「ダウンロード」フォルダ）
  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = suggestedFilename
    panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
    panel.beginSheetModal(for: window) { result in
      guard result == .OK, let url = panel.url else { return completionHandler(nil) }
      try? FileManager.default.removeItem(at: url)
      completionHandler(url)
    }
  }

  /// サーバーが止まって読み込めなかったとき
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if quitting { return }
    alert("FX Practice の画面を読み込めませんでした", "\(error.localizedDescription)\n記録: ~/Library/Logs/fx-practice.log")
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
