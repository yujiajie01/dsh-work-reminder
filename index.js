/**
 * Host half of @local/work-reminder.
 *
 * The reminder itself lives in the browser half: it owns the schedule, the
 * overlay and the chime. This half exists for the one thing a web page cannot
 * do - raising the DSH window to the front, because a timer that fires inside a
 * background window would otherwise stay unnoticed behind whatever the user is
 * doing.
 *
 * Raising a window on Windows is deliberately hard. A process that does not own
 * the foreground is refused by SetForegroundWindow: it returns false and the
 * foreground stays where it was. The only reliable way for a background helper
 * to take the foreground is to attach its input queue to the current foreground
 * thread first (AttachThreadInput), which makes the call legally "the
 * foreground thread's own request". This module does that, then verifies the
 * result with GetForegroundWindow instead of trusting a return value.
 *
 * Routes (same-origin, loopback-only):
 *
 *   POST /api/work-reminder/focus   - bring the DSH desktop window to the front
 *   GET  /api/work-reminder/state   - whether focusing is supported here
 */
import { execFile } from "node:child_process";

/** Stable cordis plugin name. */
const name = "work-reminder";
/** Services required before the routes can mount. */
const inject = ["webServer"];

/** How long the OS command may take before the answer is "could not focus". */
const FOCUS_TIMEOUT_MS = 8000;

/**
 * Window titles that identify the DSH window.
 *
 * The desktop app is an Electron shell: the browser process has no window of
 * its own, and the real window belongs to a renderer, so matching on the
 * process name alone finds nothing. The window is located by its title instead.
 */
const WINDOW_TITLES = ["DeepSeek Harness", "DeepSeek", "dsh"];

/** The PowerShell that raises the DSH window and reports what it observed. */
function focusScript() {
  const titles = WINDOW_TITLES.map((t) => "'" + t + "'").join(",");
  return [
    "$sig = @'",
    "using System;",
    "using System.Text;",
    "using System.Runtime.InteropServices;",
    "public class DshWorkReminder {",
    "  public delegate bool EnumProc(IntPtr h, IntPtr l);",
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);',
    '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);',
    "  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }",
    "  public static IntPtr FindByTitle(string[] needles) {",
    "    IntPtr found = IntPtr.Zero;",
    "    EnumWindows((h, l) => {",
    "      if (!IsWindowVisible(h)) return true;",
    "      string title = Title(h);",
    "      if (title.Length == 0) return true;",
    "      foreach (var n in needles) {",
    "        if (title.IndexOf(n, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }",
    "      }",
    "      return true;",
    "    }, IntPtr.Zero);",
    "    return found;",
    "  }",
    "}",
    "'@",
    "Add-Type -TypeDefinition $sig",
    "$needles = @(" + titles + ")",
    "$target = [DshWorkReminder]::FindByTitle($needles)",
    'if ($target -eq [IntPtr]::Zero) { Write-Output "NOTFOUND"; exit 0 }',
    // Restore first: a minimized window can still be reported as the foreground
    // one, so checking the foreground before this would skip the restore.
    "if ([DshWorkReminder]::IsIconic($target)) { [DshWorkReminder]::ShowWindow($target, 9) | Out-Null; Start-Sleep -Milliseconds 350 }",
    "$before = [DshWorkReminder]::GetForegroundWindow()",
    'if ($before -eq $target) { Write-Output ("OK already " + [DshWorkReminder]::Title($target)); exit 0 }',
    // Attach to the current foreground thread so the call is not refused.
    "$fgThread = [DshWorkReminder]::GetWindowThreadProcessId($before, [ref]$null)",
    "$targetThread = [DshWorkReminder]::GetWindowThreadProcessId($target, [ref]$null)",
    "$curThread = [DshWorkReminder]::GetCurrentThreadId()",
    "$attachedFg = $false",
    "$attachedTarget = $false",
    "if ($fgThread -ne 0 -and $fgThread -ne $curThread) { $attachedFg = [DshWorkReminder]::AttachThreadInput($curThread, $fgThread, $true) }",
    "if ($targetThread -ne 0 -and $targetThread -ne $curThread) { $attachedTarget = [DshWorkReminder]::AttachThreadInput($curThread, $targetThread, $true) }",
    "[DshWorkReminder]::BringWindowToTop($target) | Out-Null",
    "$raised = [DshWorkReminder]::SetForegroundWindow($target)",
    "if ($attachedFg) { [DshWorkReminder]::AttachThreadInput($curThread, $fgThread, $false) | Out-Null }",
    "if ($attachedTarget) { [DshWorkReminder]::AttachThreadInput($curThread, $targetThread, $false) | Out-Null }",
    "Start-Sleep -Milliseconds 300",
    // Trust what the system reports, not what the call returned.
    "$after = [DshWorkReminder]::GetForegroundWindow()",
    'if ($after -eq $target) { Write-Output ("OK " + [DshWorkReminder]::Title($target)) }',
    'else { Write-Output ("FAIL raised=" + $raised + " before=" + [DshWorkReminder]::Title($before) + " after=" + [DshWorkReminder]::Title($after)) }',
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
        } else if (text === "NOTFOUND") {
          resolve({ focused: false, detail: "no DSH window found" });
        } else {
          resolve({ focused: false, detail: text || "focus did not take effect" });
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
  if (!(hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127\./.test(hostname))) return false;
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
