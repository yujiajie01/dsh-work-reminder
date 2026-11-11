/**
 * Client half of @local/work-reminder.
 *
 * Owns everything the user sees: the reminder times, the schedule, the
 * full-screen animated overlay and the chime. The host half contributes the
 * one thing a page cannot do on its own - raising the DSH window.
 */
window.__ModuleLoader__.load({
  id: '@local/work-reminder',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'work-reminder';
    const STORAGE_KEY = 'dsh.work-reminder.v1';
    const SNOOZE_MS = 5 * 60 * 1000;
    /** Default times: lunch break and end of the workday. */
    const DEFAULT_TIMES = ['12:10', '18:00'];
    /** Bounds for how many reminder points a user may keep. */
    const MAX_TIMES = 12;
    /** How long before the deadline the dock turns amber. */
    const SOON_MS = 10 * 60 * 1000;
    /**
     * How late a reminder may still fire. A background tab throttles timers to
     * about one tick a minute, so a narrow window would silently drop the
     * reminder; two minutes also covers a laptop that slept through it.
     */
    const CATCH_UP_MS = 2 * 60 * 1000;

    const ZH = {
      title: '下班提醒',
      label: '下班提醒',
      dueNow: '该休息了',
      snooze: '延迟五分钟',
      dismiss: '知道了',
      settings: '提醒时间',
      addTime: '添加时间',
      removeTime: '删除',
      save: '保存',
      cancel: '取消',
      hint: '到点会聚焦 DSH 窗口并全屏提醒',
      focusFailed: '窗口未能置前',
      focusOk: '已聚焦窗口',
      next: '下次提醒',
      none: '未设置提醒时间',
      invalid: '时间格式应为 HH:MM',
      duplicate: '时间重复',
      tooMany: '最多 12 个提醒时间',
      titleField: '提醒时间',
      subtitle: '按设定的时间提醒你休息;可用「延迟五分钟」稍后再说',
      soundOff: '提示音未启用',
      mute: '静音',
      unmute: '开启提示音',
      everyDay: '每天',
      autoFocus: '自动聚焦窗口',
    };

    const EN = {
      title: 'Work Reminder',
      label: 'Work reminder',
      dueNow: 'Time to rest',
      snooze: 'Snooze 5 min',
      dismiss: 'Got it',
      settings: 'Times',
      addTime: 'Add a time',
      removeTime: 'Remove',
      save: 'Save',
      cancel: 'Cancel',
      hint: 'At each time the DSH window is raised and a full-screen alert appears',
      focusFailed: 'Could not raise the window',
      focusOk: 'Window raised',
      next: 'Next reminder',
      none: 'No times set',
      invalid: 'Expected HH:MM',
      duplicate: 'That time is already in the list',
      tooMany: 'At most 12 times',
      titleField: 'Reminder times',
      subtitle: 'Reminds you to take a break at the times below; snooze to be reminded again later',
      soundOff: 'Chime off',
      mute: 'Mute',
      unmute: 'Enable chime',
      everyDay: 'every day',
      autoFocus: 'Raise the window',
    };

    const CSS = [
      /* dock strip: compact, sits under the composer like a status pill */
      '.wr-dock{display:inline-flex;align-items:center;gap:6px;padding:2px 6px 2px 8px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;',
      'font-variant-numeric:tabular-nums;user-select:none;max-width:100%}',
      '.wr-dock-ico{display:inline-flex;color:var(--dsw-alias-brand-primary);flex:none}',
      '.wr-dock-label{white-space:nowrap}',
      '.wr-dock-time{color:var(--dsw-alias-label-primary);font-weight:600;white-space:nowrap}',
      '.wr-dock-soon{color:var(--dsw-alias-state-warn-primary)}',
      '.wr-dock-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;padding:1px 8px;',
      'border-radius:999px;cursor:pointer;white-space:nowrap}',
      '.wr-dock-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.wr-dock-icon-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);',
      'display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;',
      'border-radius:999px;cursor:pointer;flex:none}',
      '.wr-dock-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',

      /* settings popover */
      '.wr-pop{position:absolute;left:0;bottom:28px;z-index:60;width:264px;padding:12px;border-radius:12px;',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);',
      'box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.wr-pop h4{margin:0 0 8px;font-size:12px;font-weight:600}',
      '.wr-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}',
      '.wr-row input[type=time]{flex:1;min-width:0;font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-primary)}',
      '.wr-row button{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:3px 8px;border-radius:6px;cursor:pointer}',
      '.wr-row button:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.wr-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:8px}',
      '.wr-actions .wr-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.wr-actions .wr-primary:hover{filter:brightness(1.08)}',
      '.wr-err{color:var(--dsw-alias-state-error-primary);margin:4px 0 0}',
      '.wr-note{color:var(--dsw-alias-label-caption);margin:6px 0 0;line-height:1.5}',

      /* full-screen overlay */
      '.wr-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
      'padding:24px;background:radial-gradient(circle at 50% 42%,rgba(28,20,12,.80),rgba(8,8,10,.94) 72%);',
      'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:wr-fade .28s ease-out both}',
      '.wr-card{position:relative;width:min(620px,92vw);padding:40px 36px 32px;border-radius:26px;text-align:center;',
      'border:1px solid rgba(255,255,255,.14);background:linear-gradient(160deg,rgba(42,34,28,.96),rgba(22,20,24,.98));',
      'box-shadow:0 30px 90px rgba(0,0,0,.62);color:#fff;animation:wr-pop .42s cubic-bezier(.2,1.2,.3,1) both}',
      '.wr-ring{position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;',
      'border:2px solid rgba(247,178,103,.55);animation:wr-pulse 2.1s ease-out infinite}',
      '.wr-ico{display:flex;justify-content:center;margin-bottom:14px;color:#f7b267}',
      '.wr-ico svg{animation:wr-swing 2.6s ease-in-out infinite;transform-origin:50% 8%}',
      '.wr-title{margin:0;font-size:clamp(34px,7vw,64px);font-weight:800;letter-spacing:-.02em;line-height:1.05;',
      'background:linear-gradient(96deg,#ffd9a3,#f7b267 42%,#ff8f6b);-webkit-background-clip:text;background-clip:text;',
      '-webkit-text-fill-color:transparent;animation:wr-shimmer 3.4s linear infinite;background-size:200% 100%}',
      '.wr-sub{margin:14px 0 0;font-size:15px;line-height:1.6;color:rgba(255,255,255,.72)}',
      '.wr-times{margin:18px 0 0;display:flex;flex-wrap:wrap;gap:8px;justify-content:center}',
      '.wr-chip{font-size:12px;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.10);',
      'border:1px solid rgba(255,255,255,.16);color:rgba(255,255,255,.86)}',
      '.wr-btnrow{margin-top:28px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap}',
      '.wr-big{appearance:none;font:inherit;font-size:17px;font-weight:650;padding:13px 30px;border-radius:14px;',
      'cursor:pointer;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;',
      'transition:transform .12s ease,background .16s ease,box-shadow .16s ease;min-width:150px}',
      '.wr-big:hover{background:rgba(255,255,255,.16);transform:translateY(-1px)}',
      '.wr-big:active{transform:translateY(0)}',
      '.wr-big-primary{background:linear-gradient(96deg,#f7b267,#e2574c);border-color:transparent;',
      'box-shadow:0 10px 26px rgba(226,87,76,.34)}',
      '.wr-big-primary:hover{background:linear-gradient(96deg,#ffc27c,#ef6b5f);box-shadow:0 12px 30px rgba(226,87,76,.44)}',
      '.wr-big:focus-visible{outline:3px solid #ffd9a3;outline-offset:2px}',
      '.wr-foot{margin-top:18px;font-size:12px;color:rgba(255,255,255,.5)}',
      '.wr-status{min-height:16px;font-size:12px;color:rgba(255,255,255,.6)}',
      '.wr-status.err{color:#ff9a8f}',

      /* keyframes */
      '@keyframes wr-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes wr-pop{from{opacity:0;transform:scale(.9) translateY(14px)}to{opacity:1;transform:none}}',
      '@keyframes wr-pulse{0%{opacity:.7;transform:scale(1)}70%{opacity:0;transform:scale(1.045)}100%{opacity:0;transform:scale(1.045)}}',
      '@keyframes wr-swing{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(9deg)}}',
      '@keyframes wr-shimmer{from{background-position:0% 50%}to{background-position:200% 50%}}',
      '@media (prefers-reduced-motion: reduce){',
      '.wr-overlay,.wr-card,.wr-ico svg,.wr-title,.wr-ring{animation:none!important}}',
    ].join('');

    //#region schedule helpers

    function pad(n) {
      return n < 10 ? '0' + n : String(n);
    }

    /** Parse "HH:MM" into minutes since midnight, or null when invalid. */
    function parseTime(text) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
      if (!m) return null;
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (hh > 23 || mm > 59) return null;
      return hh * 60 + mm;
    }

    /** Normalise "9:5" / "09:05" / " 9:05 " to "09:05", or null. */
    function normalizeTime(text) {
      const minutes = parseTime(text);
      if (minutes === null) return null;
      return pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60);
    }

    /** Sort ascending by minutes-past-midnight and drop duplicates. */
    function sortTimes(times) {
      const seen = {};
      const out = [];
      for (const time of times) {
        if (seen[time]) continue;
        seen[time] = true;
        out.push(time);
      }
      out.sort(function (a, b) { return parseTime(a) - parseTime(b); });
      return out;
    }

    /** Milliseconds until the next occurrence of a time, strictly after now. */
    function msUntil(time, now) {
      const minutes = parseTime(time);
      if (minutes === null) return Infinity;
      const at = new Date(now);
      at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      let delta = at.getTime() - now;
      if (delta <= 0) delta += 24 * 60 * 60 * 1000;
      return delta;
    }

    /** The soonest upcoming time and its delay from now. */
    function nextUpcoming(times, now) {
      let best = null;
      for (const time of times) {
        const delta = msUntil(time, now);
        if (best === null || delta < best.delta) best = { time: time, delta: delta };
      }
      return best;
    }

    function formatDelta(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (hours > 0) return hours + ':' + pad(minutes) + ':' + pad(seconds);
      return minutes + ':' + pad(seconds);
    }

    //#endregion

    //#region persisted state

    /** Read the stored settings, falling back to the defaults on any damage. */
    function readSettings() {
      const fallback = { times: DEFAULT_TIMES.slice(), muted: false, autoFocus: true };
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        const times = Array.isArray(parsed && parsed.times)
          ? sortTimes(parsed.times.map(normalizeTime).filter(function (x) { return x !== null; }))
          : null;
        return {
          times: times && times.length > 0 ? times : fallback.times,
          muted: parsed && parsed.muted === true,
          autoFocus: !(parsed && parsed.autoFocus === false),
        };
      } catch (error) {
        return fallback;
      }
    }

    function writeSettings(settings) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch (error) {
        /* storage may be unavailable; the in-memory state still works */
      }
    }

    //#endregion

    //#region sound

    /** A short two-tone chime, created lazily and reused across reminders. */
    function createSound(onChange) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      let ac = null;

      function ensure() {
        if (ac) return ac;
        if (!AudioCtor) return null;
        try {
          ac = new AudioCtor();
          ac.onstatechange = function () {
            if (onChange) onChange();
          };
        } catch (error) {
          ac = null;
        }
        return ac;
      }

      function unlock() {
        const ctx = ensure();
        if (ctx && ctx.state === 'suspended') {
          ctx.resume().catch(function () {});
        }
      }

      function tone(freq, at, duration, peak) {
        const ctx = ensure();
        if (!ctx) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + duration + 0.05);
      }

      /** Three rising pairs, about four seconds in total. */
      function chime() {
        const ctx = ensure();
        if (!ctx) return;
        unlock();
        const start = ctx.currentTime + 0.05;
        const pairs = [[659.25, 987.77], [698.46, 1046.5], [783.99, 1174.66]];
        for (let round = 0; round < pairs.length; round += 1) {
          const base = start + round * 1.15;
          tone(pairs[round][0], base, 0.42, 0.16);
          tone(pairs[round][1], base + 0.16, 0.52, 0.12);
        }
      }

      function tick() {
        const ctx = ensure();
        if (!ctx) return;
        unlock();
        tone(880, ctx.currentTime + 0.02, 0.13, 0.08);
      }

      function ready() {
        return !!ac && ac.state === 'running';
      }

      function dispose() {
        if (!ac) return;
        const current = ac;
        ac = null;
        current.onstatechange = null;
        try {
          current.close();
        } catch (error) {
          /* already closed */
        }
      }

      return { ensure: ensure, unlock: unlock, chime: chime, tick: tick, ready: ready, dispose: dispose };
    }

    //#endregion

    //#region host bridge

    /** Ask the host to raise the DSH window; never throws. */
    function requestFocus() {
      return fetch('/api/work-reminder/focus', { method: 'POST', cache: 'no-store' })
        .then(function (res) { return res.ok ? res.json() : { focused: false, detail: 'HTTP ' + res.status }; })
        .catch(function (error) { return { focused: false, detail: String(error && error.message ? error.message : error) }; });
    }

    /** Whether the host can raise a window on this platform. */
    function readCapability() {
      return fetch('/api/work-reminder/state', { cache: 'no-store' })
        .then(function (res) { return res.ok ? res.json() : { canFocus: false }; })
        .catch(function () { return { canFocus: false }; });
    }

    //#endregion

    //#region icons

    function ClockIcon(props) {
      const size = (props && props.size) || 14;
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M12 7v5l3 2' }));
    }

    function BellIcon(props) {
      const off = props && props.off;
      return h('svg', {
        viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      },
        h('path', { d: 'M6 8a6 6 0 1 1 12 0c0 4.5 1.5 6 1.5 6h-15S6 12.5 6 8Z' }),
        h('path', { d: 'M10 18a2 2 0 0 0 4 0' }),
        off ? h('path', { d: 'M4 4l16 16' }) : null);
    }

    //#endregion

    function createBundle(ctx) {
      const translate = ctx.locale.bind(NS);

      function useTranslate() {
        const force = React.useReducer(function (count) { return count + 1; }, 0)[1];
        React.useEffect(function () {
          return ctx.locale.subscribe(function () { force(); });
        }, []);
        return translate;
      }

      /** Shared reminder state, owned by the single root component. */
      function useReminder() {
        const initial = React.useMemo(readSettings, []);
        const [times, setTimes] = React.useState(initial.times);
        const [muted, setMuted] = React.useState(initial.muted);
        const [autoFocus, setAutoFocus] = React.useState(initial.autoFocus);
        const [now, setNow] = React.useState(function () { return Date.now(); });
        /** The reminder on screen, or null. */
        const [firing, setFiring] = React.useState(null);
        /** Deadlines already handled, so one tick fires once. */
        const handled = React.useRef({});
        /** Whether past deadlines have been armed as handled on this mount. */
        const armed = React.useRef(false);
        const soundRef = React.useRef(null);
        const [soundReady, setSoundReady] = React.useState(false);
        const [focusable, setFocusable] = React.useState(false);
        const [focusState, setFocusState] = React.useState('');

        React.useEffect(function () {
          const timer = setInterval(function () { setNow(Date.now()); }, 1000);
          const onVisible = function () { setNow(Date.now()); };
          document.addEventListener('visibilitychange', onVisible);
          return function () {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
          };
        }, []);

        React.useEffect(function () {
          const sound = createSound(function () { setSoundReady(sound.ready()); });
          soundRef.current = sound;
          sound.ensure();
          setSoundReady(sound.ready());
          const unlock = function () { sound.unlock(); };
          window.addEventListener('pointerdown', unlock, true);
          window.addEventListener('keydown', unlock, true);
          return function () {
            window.removeEventListener('pointerdown', unlock, true);
            window.removeEventListener('keydown', unlock, true);
            sound.dispose();
            soundRef.current = null;
          };
        }, []);

        React.useEffect(function () {
          let alive = true;
          readCapability().then(function (info) {
            if (alive) setFocusable(!!info.canFocus);
          });
          return function () { alive = false; };
        }, []);

        React.useEffect(function () {
          writeSettings({ times: times, muted: muted, autoFocus: autoFocus });
        }, [times, muted, autoFocus]);

        function raiseWindow() {
          setFocusState('pending');
          requestFocus().then(function (result) {
            setFocusState(result.focused ? 'ok' : 'fail');
          });
        }

        /**
         * A deadline that had already passed before this page was mounted is
         * history, not news: reloading at 12:15 must not replay the 12:10
         * reminder. Arming them here keeps that decision separate from the
         * catch-up window below.
         */
        React.useEffect(function () {
          if (armed.current) return;
          armed.current = true;
          const at = Date.now();
          for (const time of times) {
            const minutes = parseTime(time);
            if (minutes === null) continue;
            const deadlineAt = new Date(at);
            deadlineAt.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
            if (deadlineAt.getTime() <= at) handled.current[deadlineAt.getTime()] = true;
          }
        }, []);

        // Fire a reminder when one becomes due.
        React.useEffect(function () {
          if (firing) return;
          for (const time of times) {
            const minutes = parseTime(time);
            if (minutes === null) continue;
            const at = new Date(now);
            at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
            const deadline = at.getTime();
            if (now < deadline || handled.current[deadline]) continue;
            // Past the catch-up window the reminder is too stale to be useful
            // as a full-screen alert; retire it silently.
            handled.current[deadline] = true;
            if (now - deadline > CATCH_UP_MS) continue;
            setFiring({ time: time, at: deadline });
            if (!muted && soundRef.current) soundRef.current.chime();
            if (autoFocus) raiseWindow();
            return;
          }
        }, [now, times, muted, autoFocus, firing]);

        function snooze() {
          const target = Date.now() + SNOOZE_MS;
          const at = new Date(target);
          const time = pad(at.getHours()) + ':' + pad(at.getMinutes());
          setFiring(null);
          window.setTimeout(function () {
            setFiring({ time: time, at: target });
            if (!muted && soundRef.current) soundRef.current.chime();
            if (autoFocus) raiseWindow();
          }, SNOOZE_MS);
        }

        function dismiss() {
          setFiring(null);
          setFocusState('');
        }

        return {
          times: times, setTimes: setTimes,
          muted: muted, setMuted: setMuted,
          autoFocus: autoFocus, setAutoFocus: setAutoFocus,
          now: now,
          firing: firing, dismiss: dismiss, snooze: snooze,
          sound: soundRef, soundReady: soundReady,
          focusable: focusable, focusState: focusState,
        };
      }

      /** The settings popover, opened from the dock strip. */
      function SettingsPanel(props) {
        const t = props.t;
        const [draft, setDraft] = React.useState(props.times.slice());
        const [error, setError] = React.useState('');

        function update(index, value) {
          setDraft(function (current) {
            const next = current.slice();
            next[index] = value;
            return next;
          });
          setError('');
        }

        function add() {
          if (draft.length >= MAX_TIMES) {
            setError(t('tooMany'));
            return;
          }
          setDraft(draft.concat(['09:00']));
          setError('');
        }

        function remove(index) {
          setDraft(function (current) {
            const next = current.slice();
            next.splice(index, 1);
            return next;
          });
          setError('');
        }

        function save() {
          const normalized = [];
          for (const entry of draft) {
            const time = normalizeTime(entry);
            if (time === null) {
              setError(t('invalid') + ': ' + entry);
              return;
            }
            normalized.push(time);
          }
          const unique = sortTimes(normalized);
          if (unique.length !== normalized.length) {
            setError(t('duplicate'));
            return;
          }
          if (unique.length === 0) {
            setError(t('invalid'));
            return;
          }
          props.onSave(unique);
          props.onClose();
        }

        const rows = draft.map(function (entry, index) {
          return h('div', { className: 'wr-row', key: index },
            h('input', {
              type: 'time',
              value: normalizeTime(entry) || '',
              'aria-label': t('titleField') + ' ' + (index + 1),
              onChange: function (event) { update(index, event.target.value); },
            }),
            h('button', {
              type: 'button',
              onClick: function () { remove(index); },
              title: t('removeTime'),
              'aria-label': t('removeTime') + ' ' + (index + 1),
            }, '\u00d7'));
        });

        return h('div', {
          className: 'wr-pop',
          role: 'dialog',
          'aria-label': t('settings'),
          onKeyDown: function (event) {
            if (event.key === 'Escape') props.onClose();
          },
        },
          h('h4', null, t('titleField')),
          rows,
          h('div', { className: 'wr-row' },
            h('button', {
              type: 'button',
              onClick: add,
              style: { flex: '1 1 auto' },
            }, '+ ' + t('addTime'))),
          h('label', { className: 'wr-note', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('input', {
              type: 'checkbox',
              checked: props.autoFocus,
              onChange: function (event) { props.onAutoFocus(event.target.checked); },
            }),
            t('autoFocus')),
          error ? h('p', { className: 'wr-err', role: 'alert' }, error) : null,
          h('p', { className: 'wr-note' }, t('hint')),
          h('div', { className: 'wr-actions' },
            h('button', { type: 'button', onClick: props.onClose }, t('cancel')),
            h('button', { type: 'button', className: 'wr-primary', onClick: save }, t('save'))));
      }

      /** The compact strip that sits in the composer dock. */
      function Dock(props) {
        const t = useTranslate();
        const state = props.state;
        const [open, setOpen] = React.useState(false);
        const next = nextUpcoming(state.times, state.now);
        const soon = next !== null && next.delta <= SOON_MS;

        function toggleMute() {
          const value = !state.muted;
          state.setMuted(value);
          if (!value && state.sound.current) state.sound.current.tick();
        }

        const clock = next === null
          ? h('span', { className: 'wr-dock-label' }, t('none'))
          : h('span', { className: 'wr-dock-time' + (soon ? ' wr-dock-soon' : '') },
            next.time.toUpperCase(), ' \u00b7 ', formatDelta(next.delta));

        return h('div', { style: { position: 'relative' } },
          h('div', {
            className: 'wr-dock',
            title: next === null
              ? t('none')
              : t('next') + ' ' + next.time.toUpperCase() + ' \u00b7 ' + t('everyDay'),
          },
            h('span', { className: 'wr-dock-ico' }, h(ClockIcon, null)),
            h('span', { className: 'wr-dock-label' }, t('label')),
            clock,
            h('button', {
              className: 'wr-dock-btn',
              type: 'button',
              onClick: function () { setOpen(!open); },
              'aria-expanded': open ? 'true' : 'false',
              title: t('settings'),
            }, t('settings')),
            h('button', {
              className: 'wr-dock-icon-btn',
              type: 'button',
              onClick: toggleMute,
              title: state.muted ? t('unmute') : t('mute'),
              'aria-label': state.muted ? t('unmute') : t('mute'),
              'aria-pressed': !state.muted,
            }, h(BellIcon, { off: state.muted }))),
          open
            ? h(SettingsPanel, {
              t: t,
              times: state.times,
              autoFocus: state.autoFocus,
              onSave: function (value) { state.setTimes(value); },
              onAutoFocus: state.setAutoFocus,
              onClose: function () { setOpen(false); },
            })
            : null);
      }

      /** The full-screen alert. */
      function Alert(props) {
        const t = useTranslate();
        const state = props.state;
        const firing = state.firing;
        const okRef = React.useRef(null);

        React.useEffect(function () {
          if (okRef.current) okRef.current.focus();
          const onKey = function (event) {
            if (event.key === 'Escape') state.dismiss();
          };
          window.addEventListener('keydown', onKey, true);
          return function () { window.removeEventListener('keydown', onKey, true); };
        }, [firing !== null]);

        if (!firing) return null;

        const note = state.focusState === 'fail'
          ? t('focusFailed')
          : state.focusState === 'ok'
            ? t('focusOk')
            : '';

        return h('div', {
          className: 'wr-overlay',
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-labelledby': 'wr-title',
        },
          h('div', { className: 'wr-card' },
            h('div', { className: 'wr-ring' }),
            h('div', { className: 'wr-ico' }, h(ClockIcon, { size: 58 })),
            h('h2', { className: 'wr-title', id: 'wr-title' }, t('dueNow')),
            h('p', { className: 'wr-sub' }, t('subtitle')),
            h('div', { className: 'wr-times' },
              h('span', { className: 'wr-chip' }, firing.time.toUpperCase()),
              h('span', { className: 'wr-chip' }, t('everyDay'))),
            h('div', { className: 'wr-btnrow' },
              h('button', {
                className: 'wr-big',
                type: 'button',
                onClick: state.snooze,
              }, t('snooze')),
              h('button', {
                ref: okRef,
                className: 'wr-big wr-big-primary',
                type: 'button',
                onClick: state.dismiss,
              }, t('dismiss'))),
            h('div', { className: 'wr-status' + (state.focusState === 'fail' ? ' err' : '') }, note),
            h('div', { className: 'wr-foot' }, t('hint'))));
      }

      function registerLocales() {
        const entries = [['zh', ZH], ['zh-CN', ZH], ['en', EN], ['en-US', EN]];
        const disposers = [];
        for (const entry of entries) {
          try {
            disposers.push(ctx.locale.register(NS, entry[0], entry[1]));
          } catch (error) {
            /* another mount already registered this dictionary */
          }
        }
        return disposers;
      }

      /** One component owns the state and renders both the dock and the overlay. */
      function Root() {
        const state = useReminder();
        return h(React.Fragment, null,
          h('style', null, CSS),
          h(Dock, { state: state }),
          h(Alert, { state: state }));
      }

      return { Root: Root, registerLocales: registerLocales };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const bundle = createBundle(ctx);

        const disposers = bundle.registerLocales();
        ctx.effect(function () {
          return function () {
            for (const dispose of disposers) dispose();
          };
        });

        const mount = function () {
          return ctx.slots.inject('conversation.composer.dock', function () {
            return ctx.slots.register({
              name: 'conversation.composer.dock',
              id: 'work-reminder',
              order: 6,
              label: function () { return ctx.locale.bind(NS)('label'); },
            }, bundle.Root);
          });
        };
        ctx.effect(mount);
      },
    };
  },
});
