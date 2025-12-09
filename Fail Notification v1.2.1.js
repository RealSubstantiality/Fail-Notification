// Fail Notification v1.2.1
// - 失败/空内容蜂鸣（含 iOS 振荡器兜底）、Android 振动（可调时长/次数）
// - text/html/Cloudflare 错误页判失败
// - 系统通知(需权限；iOS 仅 PWA 可用)
// - 标题闪烁提醒（可开关；测试按钮也会闪）
// - 扩展面板按钮/输入统一样式与排版

(() => {
  const MODULE = 'fail_notification';

  // ---------- HTML 错误页识别 ----------
  function isBadCT(ct = '') {
    ct = String(ct).toLowerCase();
    return ct.includes('text/html');
  }
  function looksLikeHtml(s = '') {
    if (!s) return false;
    const head = s.slice(0, 256).toLowerCase().trim();
    return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('cloudflare');
  }

  // ---------- 运行环境 ----------
  const IOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgentData?.platform === 'iOS') ||
    (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
  const VIB_SUPPORTED = typeof navigator.vibrate === 'function' && !IOS;

  const NOTIF_SUPPORTED = 'Notification' in window;
  const SW_SUPPORTED = 'serviceWorker' in navigator;
  const IS_STANDALONE =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (typeof navigator.standalone === 'boolean' && navigator.standalone);
  function iosNotifUsable() {
    if (!IOS) return true;
    return NOTIF_SUPPORTED && SW_SUPPORTED && IS_STANDALONE;
  }

  // ---------- ST 上下文 & 持久化 ----------
  const ctx = (globalThis.SillyTavern?.getContext?.() ?? globalThis);
  const extensionSettings =
    ctx.extension_settings ?? ctx.extensionSettings ?? (globalThis.extension_settings ||= {});
  const saveSettingsDebounced =
    ctx.saveSettingsDebounced ?? globalThis.saveSettingsDebounced ?? (() => {});

  const defaults = Object.freeze({
    enabled: true,
    sound: true,
    vibrate: false,
    volume: 0.9,                // 0~1
    soundUrl: './fail.mp3',
    vibMs: 180,                 // 振动时长
    vibRepeat: 1,               // 振动次数（1~5）

    // 系统通知
    notify: false,
    notifyTitle: 'SillyTavern：生成失败',
    notifyBody: '可能是网络/接口异常或空响应，请检查。',
    notifyRequireInteraction: false,

    // 标题闪烁
    titleBlink: true,
    titleBlinkTimes: 6,
    titleBlinkGap: 600
  });

  function getSettings() {
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(defaults);
    for (const k of Object.keys(defaults)) {
      if (!Object.hasOwn(extensionSettings[MODULE], k)) extensionSettings[MODULE][k] = defaults[k];
    }
    return extensionSettings[MODULE];
  }
  const S = getSettings();
  if (!VIB_SUPPORTED) S.vibrate = false;

  // ---------- 标题闪烁 ----------
  function blinkTitle(msg, times = 6, gap = 600) {
    try {
      const orig = document.title;
      let left = Math.max(1, Math.round(times)), on = false;
      const timer = setInterval(() => {
        document.title = on ? orig : (msg || '[失败]');
        on = !on;
        if (--left <= 0) { clearInterval(timer); document.title = orig; }
      }, Math.max(200, Math.round(gap)));
    } catch {}
  }

  // ---------- 音频 & 震动 ----------
  let audioCtx, failBuffer = null, lastBeep = 0, unlocked = false;

  function ensureAudio() {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  async function preload() {
    try {
      const url = new URL(S.soundUrl || './fail.mp3', import.meta.url).href;
      const res = await fetch(url, { cache: 'no-store' });
      const arr = await res.arrayBuffer();
      ensureAudio();
      failBuffer = await new Promise((ok, err) => {
        try {
          const ret = audioCtx.decodeAudioData(arr, ok, err);
          if (ret?.then) ret.then(ok).catch(err);
        } catch (e) { err(e); }
      });
    } catch {
      failBuffer = null; // 降级 <audio> 或振荡器
    }
  }

  function unlockOnce() {
    try {
      ensureAudio();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      g.gain.value = 0; o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.01);
      unlocked = true;
      preload(); // iOS 也在解锁后预载
    } catch {}
    window.removeEventListener('pointerdown', unlockOnce);
    window.removeEventListener('click', unlockOnce, true);
    window.removeEventListener('touchstart', unlockOnce, { capture: true });
    window.removeEventListener('keydown', unlockOnce);
  }
  window.addEventListener('pointerdown', unlockOnce, { once: true });
  window.addEventListener('click', unlockOnce, { once: true, capture: true });
  window.addEventListener('touchstart', unlockOnce, { once: true, passive: true, capture: true });
  window.addEventListener('keydown', unlockOnce, { once: true });

function oscBeep(durMs = 180, freq = 880) {
  try {
    ensureAudio();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    o.connect(g); g.connect(audioCtx.destination);
    const t0 = audioCtx.currentTime;
    const vol = Math.max(0, Math.min(1, Number(S.volume) || 0.9));
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
    o.start(); o.stop(t0 + durMs / 1000);
  } catch {}
}

function beep() {
  const now = Date.now();
  if (!S.enabled || !S.sound) return;
  if (now - lastBeep < 400) return;
  lastBeep = now;

  const vol = Math.max(0, Math.min(1, Number(S.volume) || 0.9));
  const url = new URL(S.soundUrl || './fail.mp3', import.meta.url).href;

  // 0) 首发在后台且未解锁：<audio> 大概率被拦，直接用振荡器兜底
  if (document.hidden && !unlocked) {
    oscBeep(Math.max(120, Math.min(1000, Math.round(S.vibMs || 180))), 880);
    return;
  }

  // 1) WebAudio Buffer 优先（旧版策略）
  if (failBuffer) {
    try {
      ensureAudio();
      const src = audioCtx.createBufferSource();
      const gain = audioCtx.createGain();
      gain.gain.value = vol;
      src.buffer = failBuffer;
      src.connect(gain); gain.connect(audioCtx.destination);
      src.start();
      return;
    } catch {}
  }

  // 2) 再尝试 <audio> 播放文件
  try {
    const a = new Audio(url);
    a.playsInline = true;
    a.preload = 'auto';
    a.volume = vol;
    const p = a.play();
    if (p && p.catch) p.catch(() => {
      oscBeep(Math.max(120, Math.min(1000, Math.round(S.vibMs || 180))), 880);
    });
    return;
  } catch {}

  // 3) 最后兜底：振荡器
  oscBeep(Math.max(120, Math.min(1000, Math.round(S.vibMs || 180))), 880);
}

  function vibrate() {
    if (!S.enabled || !S.vibrate || !VIB_SUPPORTED) return;
    const d  = Math.max(50, Math.min(2000, Math.round(Number(S.vibMs) || 180)));
    const n  = Math.max(1, Math.min(5, Math.round(Number(S.vibRepeat) || 1)));
    const gap = 100;
    const pattern = [];
    for (let i = 0; i < n; i++) { if (i) pattern.push(gap); pattern.push(d); }
    try { navigator.vibrate(pattern); } catch {}
  }

  // ---------- 系统通知 ----------
  async function ensureNotifPermission() {
    if (!NOTIF_SUPPORTED) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      const p = await Notification.requestPermission();
      return p === 'granted';
    } catch { return false; }
  }

async function sendNotification(title, body) {
  if (!S.enabled || !S.notify) return;
  if (!NOTIF_SUPPORTED) return;
  if (IOS && !iosNotifUsable()) return;

  const ok = await ensureNotifPermission();
  if (!ok) return;

  const options = {
    body: body || '',
    // 每次都用唯一 tag，确保不被合并；同时打开 renotify
    tag: 'st-fail-' + Date.now(),
    renotify: true,
    requireInteraction: !!S.notifyRequireInteraction,
  };

  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.showNotification) { await reg.showNotification(title || 'SillyTavern：生成失败', options); return; }
  } catch {}
  try { new Notification(title || 'SillyTavern：生成失败', options); } catch {}
}

  // Alt+Shift+B 测试（含标题闪烁/通知）
  window.addEventListener('keydown', e => {
    if (e.altKey && e.shiftKey && e.code === 'KeyB') {
      if (S.sound) beep();
      if (S.vibrate) vibrate();
      if (S.notify) sendNotification(S.notifyTitle, '[测试] ' + S.notifyBody);
      if (S.titleBlink) blinkTitle('[测试失败] ' + document.title, S.titleBlinkTimes, S.titleBlinkGap);
    }
  });

  if (!IOS) preload();

  // ---------- 一轮生成侦测 ----------
  const CFG = { armMs: 20000 };
  let armedUntil = 0, roundActive = false, gotContent = false, userAborted = false;

  function arm() { armedUntil = Date.now() + CFG.armMs; }
  const isArmed = () => Date.now() <= armedUntil;
  function startRound() { roundActive = true; gotContent = false; userAborted = false; }
  function markContent() { if (roundActive) gotContent = true; }
  function markAbort() { if (roundActive) userAborted = true; }
  function endRound(ok) {
    if (!roundActive) return;
    const had = gotContent, aborted = userAborted;
    roundActive = false;
    if (!aborted && (!ok || !had)) {
      beep();
      vibrate();
      sendNotification(S.notifyTitle, S.notifyBody);
      if (S.titleBlink) blinkTitle('[生成失败] ' + document.title, S.titleBlinkTimes, S.titleBlinkGap);
    }
  }

  // manifest.json 需把 "generate_interceptor" 指向 failNotificationIntercept
  globalThis.failNotificationIntercept = function (payload) {
    try { unlockOnce(); } catch {}
    arm();
    return payload;
  };

  const GEN_ALLOW = [
    /\/api\/openai\/chat\/completions/i, /\/api\/openai\/completions/i,
    /\/api\/chat\/completions/i, /\/api\/extra\/generate/i,
    /\/api\/textgen.*generate/i, /\/api\/kobold.*generate/i,
    /\/api\/ollama.*generate/i,  /\/api\/vllm.*generate/i,
    /\/api\/claude.*(chat|complete)/i, /\/api\/gemini.*(chat|generate)/i,
    /\/api\/.*\/generate/i,
    /\/api\/.*(chat|completions|generate)/i
  ];
  const GEN_DENY = [/\/api\/(characters|chats|history|profile|settings|quick|preset|images?|assets?)\b/i];
  const isGen = (url, method) =>
    method === 'POST' && !GEN_DENY.some(r => r.test(url)) && GEN_ALLOW.some(r => r.test(url));

  if (typeof window.fetch === 'function' && !window.fetch.__fn120) {
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : (input?.url || '');
      const method = (init?.method || 'GET').toUpperCase();
      const watch = isArmed() && isGen(url, method);
      if (watch) startRound();

      try {
        const res = await orig(...args);
        if (!watch) return res;

        const ct = res.headers?.get?.('content-type') || '';
        let ok2 = !!res.ok && !isBadCT(ct);

        try {
          const clone = res.clone();
          if (clone.body?.getReader) {
            (async () => {
              try {
                const reader = clone.body.getReader();
                for (;;) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  if (value?.length) markContent();
                }
              } catch {}
              finally { endRound(ok2); }
            })();
          } else {
            clone.text().then(t => {
              if (t?.trim()) markContent();
              if (ok2 && looksLikeHtml(t)) ok2 = false;
              endRound(ok2);
            }).catch(() => endRound(ok2));
          }
        } catch { endRound(ok2); }

        return res;
      } catch (err) {
        if (watch && (err?.name === 'AbortError' || err?.code === 20)) { markAbort(); endRound(true); }
        else if (watch) { endRound(false); }
        throw err;
      }
    };
    window.fetch.__fn120 = true;
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && !XHR.prototype.__fn120) {
    const _open = XHR.prototype.open;
    const _send = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      this.__meta = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      return _open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      try {
        const { method, url } = this.__meta || {};
        const watch = isArmed() && isGen(url, method);
        if (watch) {
          startRound();
          this.addEventListener('loadend', () => {
            const ok = this.status >= 200 && this.status < 400;
            const txt = this.responseText || '';
            if (txt?.trim()) markContent();

            const ct = (this.getResponseHeader && this.getResponseHeader('content-type')) || '';
            let ok2 = ok && !isBadCT(ct);
            if (ok2 && looksLikeHtml(txt)) ok2 = false;

            endRound(ok2);
          });
          this.addEventListener('error',   () => endRound(false));
          this.addEventListener('timeout', () => endRound(false));
          this.addEventListener('abort',   () => { markAbort(); endRound(true); });
        }
      } catch {}
      return _send.apply(this, args);
    };
    XHR.prototype.__fn120 = true;
  }

  // ---------- 扩展管理页 ----------
  function makeCheckbox(label, key) {
    const wrap = document.createElement('label');
    wrap.className = 'checkbox_label';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!S[key];
    input.addEventListener('change', () => { S[key] = input.checked; saveSettingsDebounced(); });
    wrap.append(input, document.createTextNode(' ' + label));
    return wrap;
  }
  function makeRange(label, key, min, max, step) {
    const wrap = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = `${label}：`;
    const input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step;
    input.value = Number(S[key]);
    const val = document.createElement('span');
    val.style.marginLeft = '8px'; val.textContent = String(S[key]);
    input.addEventListener('input', () => {
      S[key] = Number(input.value);
      val.textContent = String(S[key]);
      saveSettingsDebounced();
    });
    wrap.append(span, input, val);
    return wrap;
  }
  function makeNumber(label, key, min, max, step = 1) {
    const wrap = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = `${label}：`;
    span.style.marginRight = '8px';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(S[key] ?? '');
    input.style.width = '120px';
    input.addEventListener('change', () => {
      let v = Number(input.value);
      if (Number.isNaN(v)) v = defaults[key];
      v = Math.max(min, Math.min(max, v));
      S[key] = v;
      input.value = String(v);
      saveSettingsDebounced();
    });
    wrap.append(span, input);
    return wrap;
  }
  function makeText(label, key, placeholder = '') {
    const wrap = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = `${label}：`;
    const input = document.createElement('input');
    input.type = 'text'; input.style.width = '90%';
    input.placeholder = placeholder; input.value = S[key] || '';
    input.addEventListener('change', () => {
      S[key] = input.value || placeholder;
      saveSettingsDebounced();
      if (!IOS || unlocked) preload();
    });
    wrap.append(span, input);
    return wrap;
  }

  // —— 统一样式 & 行容器 + 按钮 —— //
function injectFnStyles() {
  if (document.getElementById('fn_styles')) return;
  const st = document.createElement('style');
  st.id = 'fn_styles';
  st.textContent = `
  #fn_inline_drawer .fn-row{
    display:flex; flex-wrap:wrap; align-items:center;
    gap:8px; margin:6px 0;
  }
  /* 关键：子项不收缩，避免被压成一列一字 */
  #fn_inline_drawer .fn-row > *{
    flex:0 0 auto; min-width:max-content;
  }

  #fn_inline_drawer .menu_button{
    height:28px; line-height:28px; padding:0 12px; margin:0 8px 0 0;
    white-space:nowrap; flex:0 0 auto; min-width:max-content;
  }
  #fn_inline_drawer label.checkbox_label{
    display:flex; align-items:center; gap:6px; margin:6px 0;
    white-space:nowrap; flex:0 0 auto; min-width:max-content;
  }
  #fn_inline_drawer input[type="text"],
  #fn_inline_drawer input[type="number"]{
    height:28px;
  }
  `;
  document.head.appendChild(st);
}

  function makeBtn(text, onclick) {
    const btn = document.createElement('button');
    btn.className = 'menu_button';
    btn.textContent = text;
    btn.addEventListener('click', onclick);
    return btn;
  }
  function makeTestRow(S, beep, vibrate, sendNotification, blinkTitle) {
    const row = document.createElement('div');
    row.className = 'fn-row';
    const btn = makeBtn('测试', () => {
      if (S.sound) beep();
      if (S.vibrate) vibrate();
      if (S.notify) sendNotification(S.notifyTitle, '[测试] ' + S.notifyBody);
      if (S.titleBlink) blinkTitle('[测试失败] ' + document.title, S.titleBlinkTimes, S.titleBlinkGap);
    });
    btn.id = 'fn_test_btn';
    row.append(btn);
    return row;
  }
  function makeNotifRow(ensureNotifPermission, sendNotification, S) {
    const row = document.createElement('div');
    row.className = 'fn-row';
    row.append(
      makeBtn('请求通知权限', async () => { await ensureNotifPermission(); }),
      makeBtn('测试通知', () => sendNotification(S.notifyTitle, '[测试] ' + S.notifyBody))
    );
    return row;
  }

  function mountSettingsUI() {
    const host = document.getElementById('extensions_settings');
    if (!host || document.getElementById('fn_inline_drawer')) return;

    injectFnStyles();

    const drawer = document.createElement('div');
    drawer.className = 'inline-drawer';
    drawer.id = 'fn_inline_drawer';

    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header';
    const title = document.createElement('b');
    title.textContent = 'Fail Notification';
    const icon = document.createElement('div');
    icon.classList.add('inline-drawer-icon','fa-solid','fa-circle-chevron-down','down');
    header.append(title, icon);

    const content = document.createElement('div');
    content.className = 'inline-drawer-content';

    // 基础
    content.append(makeCheckbox('启用','enabled'));
    content.append(makeCheckbox('失败时播放声音','sound'));
    content.append(makeRange('音量','volume',0,1,0.01));

    // 振动
    const vibRow = makeCheckbox('失败时振动（Android设备）','vibrate');
    if (!VIB_SUPPORTED) {
      const input = vibRow.querySelector('input');
      input.checked = false; input.disabled = true;
      vibRow.title = '当前平台/浏览器不支持网页振动';
    }
    content.append(vibRow);
    const vibMsRow = makeNumber('振动时长 (ms)','vibMs',50,2000,10);
    const vibCntRow = makeNumber('振动次数','vibRepeat',1,5,1);
    if (!VIB_SUPPORTED) {
      vibMsRow.querySelector('input').disabled = true;
      vibCntRow.querySelector('input').disabled = true;
      vibMsRow.style.opacity = '0.6';
      vibCntRow.style.opacity = '0.6';
    }
    content.append(vibMsRow, vibCntRow);

    // 声音文件
    content.append(makeText('声音文件路径','soundUrl','./fail.mp3'));

    // 系统通知
    const notifChk = makeCheckbox('系统通知（Windows/iOS，需授权）','notify');
    if (IOS && !iosNotifUsable()) {
      const input = notifChk.querySelector('input');
      input.checked = false; input.disabled = true;
      notifChk.title = 'iOS 需：添加到主屏(PWA) + Service Worker + 授权通知';
    }
    content.append(notifChk);
    content.append(makeText('通知标题','notifyTitle', defaults.notifyTitle));
    content.append(makeText('通知正文','notifyBody', defaults.notifyBody));
    const requireRow = makeCheckbox('通知常驻直到点击（桌面更明显）','notifyRequireInteraction');
    content.append(requireRow);
    content.append(makeNotifRow(ensureNotifPermission, sendNotification, S));

    // 标题闪烁
    content.append(makeCheckbox('失败时标题闪烁提醒','titleBlink'));
    content.append(makeNumber('闪烁次数','titleBlinkTimes',2,20,1));
    content.append(makeNumber('闪烁间隔 (ms)','titleBlinkGap',200,3000,50));

    // 总测试
    content.append(makeTestRow(S, beep, vibrate, sendNotification, blinkTitle));

    drawer.append(header, content);
    host.append(drawer);
  }

  // 引导挂载
  if (document.getElementById('extensions_settings')) {
    mountSettingsUI();
  } else {
    const mo = new MutationObserver(() => {
      if (document.getElementById('extensions_settings')) { mountSettingsUI(); mo.disconnect(); }
    });
    mo.observe(document.documentElement, { childList:true, subtree:true });
  }
})();
