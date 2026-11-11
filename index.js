/**
 * Host half of @local/work-reminder.
 *
 * The reminder itself lives in the browser half: it owns the schedule, the
 * overlay and the chime. This half exists for the one thing a web page cannot
 * do — raise the DSH window to the front, because a timer that fires inside a
 * background window would otherwise stay unnoticed behind whatever the user is
 * doing.
 *
 * Routes (same-origin, loopback-only):
 *
 *   POST /api/work-reminder/focus   - bring the DSH desktop window to the front
 *   GET  /api/work-reminder/state   - whether focusing is supported here
 *
 * Focusing is best-effort by design. A browser tab in Chrome cannot be raised
 * by the page itself, and this plugin does not pretend otherwise: the route
 * reports what it could do, and the client only claims "brought to front" when
 * the host says it succeeded.
 */
import { execFile } from "node:child_process";
import os from "node:os";

/** Stable cordis plugin name. */
const name = "work-reminder";
/** Services required before the routes can mount. */
const inject = ["webServer"];

/** How long the OS command may take before the answer is "could not focus". */
const FOCUS_TIMEOUT_MS = 6000;

/**
 * The window titles / processes that count as "the DSH window".
 *
 * The desktop app's window title is the active session title, so matching on a
 * fixed title would only work for one session. Both the process name and the
 * title are matched loosely instead: the Electron app is "DeepSeek Harness",
 * and a browser tab showing the web GUI has DSH in its title.
 */
const WINDOW_MATCHERS = ["DeepSeek Harness", "DeepSeek", "dsh"];

/** The PowerShell that raises the matching window; prints OK / NOTFOUND. */
function focusScript() {
  return [
    "$sig = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class DshWorkReminderWin {",
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    "}",
    "'@",
    "Add-Type -TypeDefinition $sig",
    "$patterns = @(" + WINDOW_MATCHERS.map((m) => "'" + m + "'").join(",") + ")",
    "$target = $null",
    "foreach ($proc in Get-Process) {",
    "  if ($proc.MainWindowHandle -eq 0) { continue }",
    "  $title = $proc.MainWindowTitle",
    "  $hit = $false",
    "  foreach ($p in $patterns) {",
    "    if ($proc.ProcessName -like ('*' + $p + '*')) { $hit = $true }",
    "    if ($title -and $title -like ('*' + $p + '*')) { $hit = $true }",
    "  }",
    "  if ($hit) { $target = $proc; break }",
    "}",
    'if ($null -eq $target) { Write-Output "NOTFOUND"; exit 0 }',
    "$h = $target.MainWindowHandle",
    "if ([DshWorkReminderWin]::IsIconic($h)) { [DshWorkReminderWin]::ShowWindow($h, 9) | Out-Null }",
    "$ok = [DshWorkReminderWin]::SetForegroundWindow($h)",
    "[DshWorkReminderWin]::BringWindowToTop($h) | Out-Null",
    'Write-Output ("OK " + $target.ProcessName)',
  ].join("\n");
}

/** Run the focus command; resolves { focused, detail }. */
function focusWindow() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve({ focused: false, detail: "window focusing is implemented for Windows only" });
      return;
    }
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", focusScript()],
      { timeout: FOCUS_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve({ focused: false, detail: "focus command failed: " + error.message });
          return;
        }
        const text = String(stdout ?? "").trim();
        if (text.startsWith("OK")) {
          resolve({ focused: true, detail: text });
        } else {
          resolve({ focused: false, detail: "no matching DSH window" });
        }
      }
    );
  });
}

/** True when the request comes from this machine only. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? "";
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost") return true;
  // Any other loopback address in 127.0.0.0/8.
  return /^127\./.test(normalized);
}

/** True when the request is same-origin with the page that hosts it. */
function isTrustedRequest(req) {
  if (!isLoopback(req)) return false;
  if (req.headers["cf-connecting-ip"] !== undefined) return false;
  if (req.headers["x-forwarded-for"] !== undefined) return false;
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  const hostname = hostUrl.hostname;
  if (!(hostname === "localhost" || hostname === "::1" || /^127\./.test(hostname) || hostname === "[::1]")) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * Build the two routes.
 * @param logError - sink for non-fatal problems.
 */
function makeRoutes(logError) {
  return [
    {
      kind: "exact",
      path: "/api/work-reminder/state",
      handler: (req, res) => {
        if (!isTrustedRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        if (req.method !== "GET") return writeJson(res, 405, { error: "method not allowed" });
        writeJson(res, 200, {
          platform: process.platform,
          canFocus: process.platform === "win32",
        });
      },
    },
    {
      kind: "exact",
      path: "/api/work-reminder/focus",
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) return writeJson(res, 403, { error: "forbidden: loopback-only" });
        if (req.method !== "POST") return writeJson(res, 405, { error: "method not allowed" });
        try {
          const result = await focusWindow();
          if (!result.focused) logError("focus did not raise a window: " + result.detail);
          writeJson(res, 200, result);
        } catch (error) {
          logError("focus failed: " + (error instanceof Error ? error.message : String(error)));
          writeJson(res, 500, { focused: false, detail: "focus failed" });
        }
      },
    },
  ];
}

/**
 * Mount the focus routes.
 * @param ctx - host plugin context carrying the web server seam.
 */
function apply(ctx) {
  const logError = (message) => {
    try {
      ctx.logger?.warn?.("[work-reminder] " + message);
    } catch {
      console.warn("[work-reminder]", message);
    }
  };
  const routes = makeRoutes(logError);
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "work-reminder: routes");
}

export { apply, inject, name };
