// Fail Notification v1.1.2
// 在 1.1.0 基础上：新增“振动时长/次数”设置 + 更稳的持久化 + 测试按钮样式；其余逻辑不变。

(() => {
  const MODULE = 'fail_notification';

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
    volume: 0.9,              // 0~1
    soundUrl: './fail.mp3',
    vibMs: 180,               // 新增：单次振动时长
    vibRepeat: 1              // 新增：振动次数（1~5）
  });

  function getSettings() {
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(defaults);
    for (const k of Object.keys(defaults)) {
      if (!Object.hasOwn(extensionSettings[MODULE], k)) extensionSettings[MODULE][k] = defaults[k];
    }
    return extensionSettings[MODULE];
  }
  const S = getSettings();

  // ---------- 音频 & 震动 ----------
  let audioCtx, failBuffer = null, lastBeep = 0;

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
      // 兼容旧实现：有的浏览器 decodeAudioData 返回 Promise，有的用回调
      failBuffer = await new Promise((ok, err) => {
        try {
          const ret = audioCtx.decodeAudioData(arr, ok, err);
          if (ret?.then) ret.then(ok).catch(err);
        } catch (e) { err(e); }
      });
    } catch {
      failBuffer = null; // 降级 <audio>
    }
  }

  const unlock = () => {
    try {
      ensureAudio();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      g.gain.value = 0; o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.01);
    } catch {}
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  function beep() {
    const now = Date.now();
    if (!S.enabled || !S.sound) return;
    if (now - lastBeep < 400) return;
    lastBeep = now;

    try {
      ensureAudio();
      if (failBuffer) {
        const src = audioCtx.createBufferSource();
        const gain = audioCtx.createGain();
        gain.gain.value = Math.max(0, Math.min(1, Number(S.volume) || 0.9));
        src.buffer = failBuffer;
        src.connect(gain); gain.connect(audioCtx.destination);
        src.start();
      } else {
        const url = new URL(S.soundUrl || './fail.mp3', import.meta.url).href;
        const a = new Audio(url);
        a.volume = Math.max(0, Math.min(1, Number(S.volume) || 0.9));
        a.play().catch(() => {});
      }
    } catch {}
  }

  function vibrate() {
    if (!S.enabled || !S.vibrate) return;
    const d  = Math.max(50, Math.min(2000, Math.round(Number(S.vibMs) || 180)));
    const n  = Math.max(1, Math.min(5, Math.round(Number(S.vibRepeat) || 1)));
    const gap = 100;
    const pattern = [];
    for (let i = 0; i < n; i++) { if (i) pattern.push(gap); pattern.push(d); }
    try { navigator.vibrate && navigator.vibrate(pattern); } catch {}
  }

  // Alt+Shift+B 试音（遵循开关）
  window.addEventListener('keydown', e => {
    if (e.altKey && e.shiftKey && e.code === 'KeyB') { beep(); vibrate(); }
  });

  preload();

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
    if (!aborted && (!ok || !had)) { beep(); vibrate(); }
  }

  globalThis.failNotificationIntercept = function (payload) { arm(); return payload; };

  const GEN_ALLOW = [
    /\/api\/openai\/chat\/completions/i, /\/api\/openai\/completions/i,
    /\/api\/chat\/completions/i, /\/api\/extra\/generate/i,
    /\/api\/textgen.*generate/i, /\/api\/kobold.*generate/i,
    /\/api\/ollama.*generate/i,  /\/api\/vllm.*generate/i,
    /\/api\/claude.*(chat|complete)/i, /\/api\/gemini.*(chat|generate)/i,
    /\/api\/.*\/generate/i
  ];
  const GEN_DENY = [/\/api\/(characters|chats|history|profile|settings|quick|preset|images?|assets?)\b/i];
  const isGen = (url, method) =>
    method === 'POST' && !GEN_DENY.some(r => r.test(url)) && GEN_ALLOW.some(r => r.test(url));

  if (typeof window.fetch === 'function' && !window.fetch.__fn112) {
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

        const ok = !!res.ok;
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
              finally { endRound(ok); }
            })();
          } else {
            clone.text().then(t => { if (t?.trim()) markContent(); endRound(ok); })
                        .catch(() => endRound(ok));
          }
        } catch { endRound(ok); }

        return res;
      } catch (err) {
        if (watch && (err?.name === 'AbortError' || err?.code === 20)) { markAbort(); endRound(true); }
        else if (watch) { endRound(false); }
        throw err;
      }
    };
    window.fetch.__fn112 = true;
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && !XHR.prototype.__fn112) {
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
            endRound(ok);
          });
          this.addEventListener('error',   () => endRound(false));
          this.addEventListener('timeout', () => endRound(false));
          this.addEventListener('abort',   () => { markAbort(); endRound(true); });
        }
      } catch {}
      return _send.apply(this, args);
    };
    XHR.prototype.__fn112 = true;
  }

  // ---------- 扩展管理页入口 ----------
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
      preload(); // 立即按新地址预载
    });
    wrap.append(span, input);
    return wrap;
  }

  function makeTestButton() {
    const wrap = document.createElement('div');
    wrap.style.marginTop = '6px';
    const btn = document.createElement('button');
    btn.className = 'menu_button';
    btn.id = 'fn_test_btn';
    btn.textContent = '测试';
    btn.style.whiteSpace = 'nowrap';
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.padding = '0 12px';
    btn.style.height = '28px';
    btn.style.minWidth = '64px';
    btn.addEventListener('click', () => { if (S.sound) beep(); if (S.vibrate) vibrate(); });
    wrap.append(btn);
    return wrap;
  }

  function mountSettingsUI() {
    const host = document.getElementById('extensions_settings');
    if (!host || document.getElementById('fn_inline_drawer')) return;

    const drawer = document.createElement('div');
    drawer.className = 'inline-drawer';
    drawer.id = 'fn_inline_drawer';

    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header';
    const title = document.createElement('b');
    title.textContent = 'Fail Notification';
    const icon = document.createElement('div');
    icon.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');
    header.append(title, icon);

    const content = document.createElement('div');
    content.className = 'inline-drawer-content';

    content.append(makeCheckbox('启用', 'enabled'));
    content.append(makeCheckbox('失败时播放声音', 'sound'));
    content.append(makeRange('音量', 'volume', 0, 1, 0.01));
    content.append(makeCheckbox('失败时振动（Android设备）', 'vibrate'));
    content.append(makeNumber('振动时长 (ms)', 'vibMs', 50, 2000, 10));   // 新增
    content.append(makeNumber('振动次数', 'vibRepeat', 1, 5, 1));         // 新增
    content.append(makeText('声音文件路径', 'soundUrl', './fail.mp3'));
    content.append(makeTestButton());

    drawer.append(header, content);
    host.append(drawer);
  }

  if (document.getElementById('extensions_settings')) {
    mountSettingsUI();
  } else {
    const mo = new MutationObserver(() => {
      if (document.getElementById('extensions_settings')) { mountSettingsUI(); mo.disconnect(); }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
