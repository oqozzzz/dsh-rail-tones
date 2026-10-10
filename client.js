/**
 * dsh-rail-tones — 浏览器半边（Client half）。
 *
 * 功能（对齐小米桌面端「导航条音效」）：在会话导航条（官方 Turn Rail）上竖向滑动、
 * 点击刻度或在导轨上滚轮翻阅时，按刻度在整场会话中的位置播放五声音阶提示音，
 * 用于提示当前会话位置。
 *
 * 契约（DSH 0.2.0-rc.2 客户端插件规范）：
 * - 通过 window.__ModuleLoader__ 注册惰性工厂，`id` 必须等于包名；
 * - React 由平台模块表提供，不 require 任何 @deepseek-ai/* 客户端包；
 * - 工厂本身无副作用；监听器、定时器、音频上下文都在 apply 内用 ctx.effect 注册并清理；
 * - 只读观察宿主 DOM：不写 DOM、不 preventDefault、不 stopPropagation，绝不干扰官方交互。
 *
 * 官方导轨结构（0.2.0-rc.2 实测）：
 *   div > nav[aria-label] > div(滚动容器, overflow-y:auto) > div > button[data-index]…
 * 刻度为虚拟滚动渲染，因此这里不缓存任何刻度节点，全部在事件到达时重新命中测试。
 */

window.__ModuleLoader__.load({
  id: 'dsh-rail-tones',
  factory(require) {
    const VERSION = '0.2.0';

    /* ------------------------------------------------------------------ *
     * 常量                                                                *
     * ------------------------------------------------------------------ */

    const SCALE = [0, 2, 4, 7, 9]; // 大调五声音阶的半音偏移
    const BASE_HZ = 220; // A3
    const OCTAVES = 2;
    const DEGREES = SCALE.length * OCTAVES; // 10 个音级
    const MIN_GAP_MS = 70; // 连续两次发声的最小间隔
    const SAME_DEGREE_MS = 250; // 同一音级的去重窗口
    const WHEEL_SETTLE_MS = 90; // 滚轮停止后再取刻度
    const OFF_RAIL_RESET_MS = 300; // 持续在导轨外这么久才清去重锚点（重渲染/蹭气泡不清）
    const TICK_HYSTERESIS_PX = 4; // 刻度吸附滞回：另一个刻度要明显更近才切换
    const SETTINGS_RETRY_MS = 400; // 设置卡片注入/注册的重试间隔
    const SETTINGS_MAX_TRIES = 60; // 有界重试上限（约 24 秒）
    const TICK_SELECTOR = 'button[data-index]'; // 官方刻度按钮
    const STORE_KEY = 'dsh-rail-tones:v1';
    const VOICES = Object.freeze({ sine: 'sine', piano: 'piano' });
    const DEFAULTS = Object.freeze({ enabled: true, volume: 0.5, voice: VOICES.sine });
    const MAX_VOLUME = 1; // 音量上限 = 100%（下限 0 = 无声）；范围收窄到 0–100%
    // 音量 1.0（100%）时的包络峰值。0.88 = 旧 200% 上限峰值 0.44 的 2 倍，
    // 即把 0%–100% 的音量差整体翻倍（最大声音再响一倍），仍在满幅之内不削波。
    const PEAK_FACTOR = 0.88;
    const ATTACK_S = 0.006;
    const DECAY_S = 0.18;
    // 钢琴音色：多分音加法合成 + 每分音独立衰减 + 轻微失谐（inharmonicity）。
    const PIANO_WEIGHTS = Object.freeze([1, 0.58, 0.38, 0.23, 0.13, 0.07]);
    // 分音权重之和：实际增益按它归一（Σ = 1）→ 任意时刻 |Σ 分音| ≤ master 峰值，不削波。
    const PIANO_WEIGHT_SUM = PIANO_WEIGHTS.reduce((acc, value) => acc + value, 0);
    const PIANO_TAUS = Object.freeze([1, 0.8, 0.65, 0.5, 0.4, 0.3]); // 相对 master 衰减的时间系数（高次分音先暗）
    const PIANO_INHARM = 0.0002; // 失谐系数：f_n = 基频 × n × (1 + 系数 × n²)，钢琴质感的关键
    const PIANO_DECAY_S = 0.45; // master 指数衰减时长（比正弦音长，琴声余韵）
    const PIANO_PEAK_SCALE = 0.8; // 满音量峰值 = PEAK_FACTOR × 0.8 ≈ 0.70，留头部空间

    const MESSAGES = {
      zh: {
        title: '导航条音效',
        desc: '光标沿会话导航条竖向划过、按住拖动、点击刻度或滚轮翻阅时，播放音阶提示音。用于提示当前会话位置。',
        switchLabel: '导航条音效开关',
        volume: '音量',
        volumeDesc: '调整导航条音量大小',
        voice: '钢琴音色',
        voiceDesc: '开启后提示音从正弦音切换为钢琴音色。只影响导航条音效。',
        preview: '试听',
        previewDesc: '试听会话中段对应的提示音（关闭开关后试听同样静音）。',
        previewButton: '试听',
      },
      en: {
        title: 'Navigation rail tones',
        desc: 'Plays a scale tone as the pointer glides along the session navigation rail, while dragging on it, on a tick click, or while scrolling it, so you can hear where you are in the session.',
        switchLabel: 'Navigation rail tones switch',
        volume: 'Volume',
        volumeDesc: 'Adjust the volume of the navigation rail tones',
        voice: 'Piano voice',
        voiceDesc: 'Switches the rail tones from sine beeps to a synthesized piano voice. Affects the navigation rail tones only.',
        preview: 'Preview',
        previewDesc: 'Plays the tone for the middle of the session (silent while the switch is off).',
        previewButton: 'Preview',
      },
    };

    /* ------------------------------------------------------------------ *
     * 纯逻辑（由 test/rail-tones.test.mjs 覆盖）                          *
     * ------------------------------------------------------------------ */

    function clamp01(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      if (value < 0) return 0;
      if (value > 1) return 1;
      return value;
    }

    /** 音色白名单：非法 / 缺失一律回退默认（存量数据没有 voice 字段，天然向后兼容）。 */
    function normalizeVoice(value) {
      return value === VOICES.sine || value === VOICES.piano ? value : null;
    }

    /** 位置（0 = 会话最早，1 = 会话最新）→ 音级下标。 */
    function degreeForPosition(position) {
      const bounded = clamp01(position);
      if (bounded === null) return null;
      return Math.round(bounded * (DEGREES - 1));
    }

    /** 音级下标 → 频率（Hz）。 */
    function noteHz(degree) {
      if (typeof degree !== 'number' || !Number.isFinite(degree)) return null;
      const index = Math.max(0, Math.min(DEGREES - 1, Math.round(degree)));
      const semitone = SCALE[index % SCALE.length] + 12 * Math.floor(index / SCALE.length);
      return BASE_HZ * Math.pow(2, semitone / 12);
    }

    /**
     * 视口坐标 → 导轨内容位置。
     * geometry: { y, rectTop, scrollTop, scrollHeight }，全部为数字。
     */
    function positionFrom(geometry) {
      if (geometry === null || typeof geometry !== 'object') return null;
      const { y, rectTop, scrollTop, scrollHeight } = geometry;
      const values = [y, rectTop, scrollTop, scrollHeight];
      for (const value of values) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      }
      if (scrollHeight <= 0) return null;
      return clamp01((y - rectTop + scrollTop) / scrollHeight);
    }

    /**
     * 刻度吸附的滞回（纯逻辑）：best 是本轮最近刻度，previous 是上一轮吸附的刻度。
     * previous 仍「足够近」（与 best 的距离差不超过 hysteresisPx）就维持原判，
     * 只有另一个刻度明显更近才切换 —— 消灭指针在相邻刻度分界线上抖动时的来回跳档。
     * 两侧均为 { centerY, index } 或 null。
     */
    function preferTick(best, previous, y, hysteresisPx) {
      if (best === null) return previous === null ? null : previous;
      if (previous === null) return best;
      if (previous.index !== null && best.index !== null && previous.index === best.index) return best;
      if (!Number.isFinite(y)) return best;
      const margin = Number.isFinite(hysteresisPx) && hysteresisPx > 0 ? hysteresisPx : 0;
      const prevDistance = Math.abs(previous.centerY - y);
      const bestDistance = Math.abs(best.centerY - y);
      return prevDistance <= bestDistance + margin ? previous : best;
    }

    /**
     * 发声调度器：节流 + 同音级去重 + 开关判断。
     * options: { play(hz, meta), now(), isEnabled(), minGapMs?, sameDegreeMs? }
     */
    function createController(options) {
      const settings = options === null || typeof options !== 'object' ? {} : options;
      const now = typeof settings.now === 'function' ? settings.now : () => Date.now();
      const minGapMs = typeof settings.minGapMs === 'number' ? settings.minGapMs : MIN_GAP_MS;
      const sameDegreeMs = typeof settings.sameDegreeMs === 'number' ? settings.sameDegreeMs : SAME_DEGREE_MS;
      let lastAt = Number.NEGATIVE_INFINITY;
      let lastDegree = null;
      let lastHz = null;
      let notesPlayed = 0;

      function signal(position, source, tick, options) {
        if (typeof settings.isEnabled === 'function' && settings.isEnabled() !== true) return false;
        const degree = degreeForPosition(position);
        if (degree === null) return false;
        // repeat = 明确的手势（按下 / 键盘激活）：即便与上一声同音级也再响一次，
        // 让「点击刻度」始终有确认音；划过/滚轮不带 repeat，避免同一刻度反复响。
        const repeat = options !== null && options !== undefined && options.repeat === true;
        const at = now();
        if (at - lastAt < minGapMs) return false;
        if (!repeat && degree === lastDegree && at - lastAt < sameDegreeMs) return false;
        const hz = noteHz(degree);
        if (hz === null) return false;
        lastAt = at;
        lastDegree = degree;
        lastHz = hz;
        notesPlayed += 1;
        if (typeof settings.play === 'function') {
          settings.play(hz, {
            degree,
            source: typeof source === 'string' ? source : 'rail',
            tick: typeof tick === 'number' && Number.isFinite(tick) ? tick : null,
          });
        }
        return true;
      }

      return {
        signal,
        reset() {
          lastAt = Number.NEGATIVE_INFINITY;
          lastDegree = null;
        },
        stats() {
          return { notesPlayed, lastHz, lastDegree };
        },
      };
    }

    /** 设置存储（localStorage；不可用时整场会话使用默认值，绝不抛错）。 */
    function createState(storage) {
      const listeners = new Set();
      let current = read();

      function read() {
        let raw = null;
        try {
          raw = storage === null || storage === undefined ? null : storage.getItem(STORE_KEY);
        } catch (error) {
          raw = null;
        }
        if (typeof raw !== 'string' || raw === '') return { ...DEFAULTS };
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          parsed = null;
        }
        if (parsed === null || typeof parsed !== 'object') return { ...DEFAULTS };
        return {
          enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
          volume:
            typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
              ? Math.min(MAX_VOLUME, Math.max(0, parsed.volume))
              : DEFAULTS.volume,
          voice: normalizeVoice(parsed.voice) === null ? DEFAULTS.voice : parsed.voice,
        };
      }

      function snapshot() {
        return { ...current };
      }

      function persist() {
        try {
          if (storage !== null && storage !== undefined) storage.setItem(STORE_KEY, JSON.stringify(current));
        } catch (error) {
          /* 隐私模式/配额：本次会话内仍然生效，只是不持久化 */
        }
      }

      return {
        get: snapshot,
        set(patch) {
          current = { ...current, ...patch };
          if (typeof current.volume === 'number' && Number.isFinite(current.volume)) {
            current.volume = Math.min(MAX_VOLUME, Math.max(0, current.volume));
          }
          if (normalizeVoice(current.voice) === null) current.voice = DEFAULTS.voice;
          persist();
          const value = snapshot();
          for (const listener of Array.from(listeners)) {
            try {
              listener(value);
            } catch (error) {
              /* 单个订阅者出错不影响其它订阅者 */
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    function safeStorage(view) {
      try {
        return view.localStorage === undefined ? null : view.localStorage;
      } catch (error) {
        return null;
      }
    }

    /* ------------------------------------------------------------------ *
     * 音频引擎（Web Audio 合成，无音频素材）                              *
     * ------------------------------------------------------------------ */

    function createEngine(options) {
      const Ctor = options.AudioContext;
      let context = null;
      let unavailable = typeof Ctor !== 'function';
      let reported = false;

      function report(error) {
        if (reported) return;
        reported = true;
        try {
          console.warn('[dsh-rail-tones] 音频不可用，已静音：', error);
        } catch (ignored) {
          /* 控制台不可用 */
        }
      }

      function ensure() {
        if (unavailable) return null;
        try {
          if (context === null) context = new Ctor();
          if (context.state !== 'running' && typeof context.resume === 'function') {
            const resumed = context.resume();
            if (resumed !== null && resumed !== undefined && typeof resumed.catch === 'function') {
              resumed.catch(() => {});
            }
          }
          return context;
        } catch (error) {
          unavailable = true;
          context = null;
          report(error);
          return null;
        }
      }

      function play(hz) {
        if (typeof hz !== 'number' || !Number.isFinite(hz)) return false;
        let volume = 0;
        try {
          volume = Number(options.volume());
        } catch (error) {
          volume = 0;
        }
        if (!Number.isFinite(volume) || volume <= 0) return false;
        let voice = DEFAULTS.voice;
        try {
          const wanted = options.voice === undefined ? null : options.voice();
          const normalized = normalizeVoice(wanted);
          if (normalized !== null) voice = normalized;
        } catch (error) {
          /* 回退默认音色 */
        }
        const audio = ensure();
        if (audio === null) return false;
        const bounded = Math.min(MAX_VOLUME, Math.max(0, volume));
        try {
          return voice === VOICES.piano ? playPiano(audio, hz, bounded) : playSine(audio, hz, bounded);
        } catch (error) {
          report(error);
          return false;
        }
      }

      /** 正弦音（v0.2.0 之前的唯一音色）：单振荡器 + 起音 + 指数衰减。 */
      function playSine(audio, hz, volume) {
        const start = audio.currentTime;
        const peak = volume * PEAK_FACTOR;
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(hz, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(peak, start + ATTACK_S);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + DECAY_S);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start(start);
        oscillator.stop(start + DECAY_S + 0.02);
        oscillator.onended = () => {
          try {
            oscillator.disconnect();
            gain.disconnect();
          } catch (error) {
            /* 已断开 */
          }
        };
        return true;
      }

      /**
       * 钢琴音色：master gain 包络下并联 6 个正弦分音，
       * 权重按 Σ 归一（任意时刻 |Σ 分音| ≤ master 峰值，不削波）、频率带轻微失谐、
       * 高次分音按各自 τ 更快衰减（先亮后暗的琴声瞬态），并在衰减到位后才 stop（避免爆音）。
       */
      function playPiano(audio, hz, volume) {
        const start = audio.currentTime;
        const peak = volume * PEAK_FACTOR * PIANO_PEAK_SCALE;
        const master = audio.createGain();
        master.gain.setValueAtTime(0.0001, start);
        master.gain.linearRampToValueAtTime(peak, start + ATTACK_S);
        master.gain.exponentialRampToValueAtTime(0.0001, start + PIANO_DECAY_S);
        master.connect(audio.destination);
        const partials = [];
        for (let i = 0; i < PIANO_WEIGHTS.length; i += 1) {
          const n = i + 1;
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(hz * n * (1 + PIANO_INHARM * n * n), start);
          const tau = PIANO_DECAY_S * PIANO_TAUS[i];
          gain.gain.setValueAtTime(PIANO_WEIGHTS[i] / PIANO_WEIGHT_SUM, start);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + tau);
          oscillator.connect(gain);
          gain.connect(master);
          oscillator.start(start);
          oscillator.stop(start + tau + 0.02);
          partials.push({ oscillator, gain });
        }
        // 任一分音结束即统一回收（同节流窗口内它们几乎同时收尾，逐个挂 onended 反而啰嗦）。
        partials[0].oscillator.onended = () => {
          for (const part of partials) {
            try {
              part.oscillator.disconnect();
              part.gain.disconnect();
            } catch (error) {
              /* 已断开 */
            }
          }
          try {
            master.disconnect();
          } catch (error) {
            /* 已断开 */
          }
        };
        return true;
      }

      return {
        play,
        /** 首次用户手势时预热音频上下文（自动播放策略）。 */
        arm() {
          ensure();
        },
        dispose() {
          const current = context;
          context = null;
          if (current === null || typeof current.close !== 'function') return;
          try {
            const closed = current.close();
            if (closed !== null && closed !== undefined && typeof closed.catch === 'function') closed.catch(() => {});
          } catch (error) {
            /* 已关闭 */
          }
        },
        state() {
          if (unavailable) return 'unavailable';
          if (context === null) return 'cold';
          return String(context.state === undefined ? 'unknown' : context.state);
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * 导轨适配（只读 DOM 观察）                                           *
     * ------------------------------------------------------------------ */

    function closestTick(target) {
      if (target === null || target === undefined || typeof target.closest !== 'function') return null;
      try {
        return target.closest(TICK_SELECTOR);
      } catch (error) {
        return null;
      }
    }

    /**
     * 事件目标是否落在会话导航条内。
     *
     * 只认「直接拥有刻度」的那个 nav：如果外壳恰好也是 `<nav>`（包裹层），
     * 它的第一个刻度的最近 nav 祖先并不是它，于是被排除 —— 否则整块面板都会
     * 被当成一条额外的导轨而乱发声。
     */
    function railNavFrom(target) {
      if (target === null || target === undefined || typeof target.closest !== 'function') return null;
      let nav = null;
      try {
        nav = target.closest('nav');
      } catch (error) {
        return null;
      }
      if (nav === null || typeof nav.querySelector !== 'function') return null;
      let tick = null;
      try {
        tick = nav.querySelector(TICK_SELECTOR);
      } catch (error) {
        return null;
      }
      if (tick === null) return null;
      if (typeof tick.closest === 'function') {
        let owner = null;
        try {
          owner = tick.closest('nav');
        } catch (error) {
          owner = null;
        }
        if (owner !== null && owner !== nav) return null;
      }
      return nav;
    }

    /** 刻度祖先中唯一的可滚动元素就是虚拟滚动的滚动容器。 */
    function scrollerFor(nav, view) {
      const tick = nav.querySelector(TICK_SELECTOR);
      if (tick === null) return null;
      let node = tick.parentElement;
      let depth = 0;
      while (node !== null && node !== nav && depth < 6) {
        const scrollHeight = Number(node.scrollHeight);
        const clientHeight = Number(node.clientHeight);
        let overflowY = '';
        try {
          const style = typeof view.getComputedStyle === 'function' ? view.getComputedStyle(node) : null;
          overflowY = style === null || style.overflowY === undefined ? '' : String(style.overflowY);
        } catch (error) {
          overflowY = '';
        }
        if (
          (overflowY === 'auto' || overflowY === 'scroll') &&
          Number.isFinite(scrollHeight) &&
          Number.isFinite(clientHeight) &&
          scrollHeight > clientHeight + 1
        ) {
          return node;
        }
        node = node.parentElement;
        depth += 1;
      }
      return null;
    }

    function centerY(element) {
      try {
        const rect = element.getBoundingClientRect();
        const center = rect.top + rect.height / 2;
        return Number.isFinite(center) ? center : null;
      } catch (error) {
        return null;
      }
    }

    /**
     * 指针下方（或最近）的刻度 → { centerY, index }。
     *
     * 音符以**刻度**为单位：先吸附到刻度中线，再换算位置。这样同一个刻度上
     * 「光标划过 / 按住滑动 / 点击」得到的是同一个音，相邻刻度共享音级时也不会
     * 因为指针在刻度带内的微小偏移而抖动。
     */
    function tickAt(nav, y) {
      let ticks = null;
      try {
        ticks = nav.querySelectorAll(TICK_SELECTOR);
      } catch (error) {
        return null;
      }
      if (ticks === null || ticks.length === 0) return null;
      let best = null;
      for (let position = 0; position < ticks.length; position += 1) {
        const tick = ticks[position];
        const center = centerY(tick);
        if (center === null) continue;
        const distance = Number.isFinite(y) ? Math.abs(center - y) : position;
        if (best !== null && distance >= best.distance) continue;
        let index = null;
        if (typeof tick.getAttribute === 'function') {
          const raw = tick.getAttribute('data-index');
          const parsed = raw === null ? Number.NaN : Number(raw);
          if (Number.isFinite(parsed)) index = parsed;
        }
        best = { distance, center, index };
      }
      return best === null ? null : { centerY: best.center, index: best.index };
    }

    function positionAt(nav, y, view, knownScroller) {
      if (!Number.isFinite(y)) return null;
      // 拖拽期间滚动容器不会变，调用方可以预先解析一次，避免每次 pointermove
      // 都做 getComputedStyle 遍历（高频事件下的布局抖动）。
      const scroller = knownScroller === undefined ? scrollerFor(nav, view) : knownScroller;
      if (scroller !== null) {
        try {
          const rect = scroller.getBoundingClientRect();
          return positionFrom({
            y,
            rectTop: rect.top,
            scrollTop: Number(scroller.scrollTop),
            scrollHeight: Number(scroller.scrollHeight),
          });
        } catch (error) {
          /* 落到下面的兜底 */
        }
      }
      try {
        // 兜底：找不到滚动容器时，退化成「指针在导轨视口内的相对高度」。
        const rect = nav.getBoundingClientRect();
        return positionFrom({ y, rectTop: rect.top, scrollTop: 0, scrollHeight: Number(rect.height) });
      } catch (error) {
        return null;
      }
    }

    /**
     * 全局委托监听（捕获阶段 + passive）：
     * 不缓存刻度节点（虚拟滚动会回收），不阻止任何默认行为。
     * env: { view, arm(), signal(position, source, tick, options) }
     */
    function attachRailListeners(env) {
      const view = env.view;
      const document = view.document;
      const options = { capture: true, passive: true };
      const scrollerCache = new WeakMap();
      let dragging = false;
      let activeNav = null;
      let activeScroller = null;
      // 去重状态：只记「上一次真正发声时所在的音级」。
      // 用音级（= 会话位置分成 10 档）而不是刻度下标做闸门：刻度会因虚拟滚动、
      // 悬停加宽、宿主重渲染而抖动，音级只跟指针在会话中的位置有关。
      let lastDegree = null;
      let lastTickIndex = null;
      let lastPosition = null;
      let lastNav = null;
      let anchoredTickIndex = null; // 滞回吸附当前所在的刻度（每轮 emit 更新）
      let skippedByDegree = 0;
      let lastSkip = null;
      let acceptedCount = 0;
      let resets = 0; // 锚点被真正清空的次数（重复发声排查的关键指标：抖动时应为 0）
      let lastReset = null;
      let offRailTimer = null; // 延迟确认「离开导轨」的定时器
      let wheelTimer = null;
      let railSeen = false;
      let disposed = false;

      function resetAnchor(reason) {
        lastDegree = null;
        lastTickIndex = null;
        lastPosition = null;
        anchoredTickIndex = null;
        resets += 1;
        lastReset = { reason: typeof reason === 'string' ? reason : 'unknown', at: Date.now() };
      }

      function cancelOffRailReset() {
        if (offRailTimer !== null) clearTimeout(offRailTimer);
        offRailTimer = null;
      }

      /**
       * 「离开导轨」一律延迟确认：
       * 悬停刻度会触发宿主重渲染（markPreview 加宽、虚拟滚动回收节点），
       * 此间 pointermove 的 target 会短暂落到已分离节点 / 预览气泡上；
       * 若立刻清锚点，下一次微小移动就会被当成「离开后重新进入」而重放同一音。
       * 只有持续在导轨外满 OFF_RAIL_RESET_MS 才真正清锚点 —— 真离开再回来仍重新发声。
       */
      function scheduleOffRailReset(reason) {
        if (offRailTimer !== null) return; // 已在倒计时，不续期
        offRailTimer = setTimeout(() => {
          offRailTimer = null;
          if (disposed) return;
          lastNav = null;
          resetAnchor(reason);
        }, OFF_RAIL_RESET_MS);
      }

      function hit(target) {
        const nav = railNavFrom(target);
        if (nav === null) return null;
        railSeen = true;
        cancelOffRailReset(); // 指针在导轨上：任何待决的「离开」立即作废
        // 换了一条导轨：去重状态清零，下一条导轨的第一个音照常发声。
        if (lastNav !== null && lastNav !== nav) resetAnchor('nav-switch');
        lastNav = nav;
        return nav;
      }

      /** 滚动容器在会话存续期内不变，缓存一次即可（弱引用，导轨重建不残留）。 */
      function scrollerForCached(nav) {
        const cached = scrollerCache.get(nav);
        if (cached !== undefined && cached.isConnected !== false) return cached;
        const resolved = scrollerFor(nav, view);
        if (resolved !== null) scrollerCache.set(nav, resolved);
        return resolved;
      }

      /** 在当前 DOM 里找回指定下标的刻度（虚拟滚动回收后返回 null，绝不缓存节点）。 */
      function resolveTickByIndex(nav, index) {
        let ticks = null;
        try {
          ticks = nav.querySelectorAll(TICK_SELECTOR);
        } catch (error) {
          return null;
        }
        if (ticks === null) return null;
        for (let position = 0; position < ticks.length; position += 1) {
          const tick = ticks[position];
          if (typeof tick.getAttribute !== 'function') continue;
          const raw = tick.getAttribute('data-index');
          const parsed = raw === null ? Number.NaN : Number(raw);
          if (parsed !== index) continue;
          const center = centerY(tick);
          return center === null ? null : { centerY: center, index };
        }
        return null;
      }

      function emit(nav, y, source, scroller, force) {
        const target = scroller === undefined || scroller === null ? scrollerForCached(nav) : scroller;
        // 音符由「指针所在刻度」决定：先吸附到刻度中线再换算位置，
        // 于是同一刻度上划过 / 按住滑动 / 点击 / 滚轮都得到同一个音。
        let tick = tickAt(nav, y);
        // 滞回吸附：相邻刻度只有「明显更近」才切换，分界线上的抖动不再跳档。
        // 明确手势（点击 / 键盘）不滞回，保证点到哪个就是哪个。
        if (force !== true && tick !== null && anchoredTickIndex !== null && Number.isFinite(y)) {
          const anchored = resolveTickByIndex(nav, anchoredTickIndex);
          if (anchored !== null) tick = preferTick(tick, anchored, y, TICK_HYSTERESIS_PX);
        }
        if (tick !== null && tick.index !== null) anchoredTickIndex = tick.index;
        const index = tick === null ? null : tick.index;
        const position = positionAt(nav, tick === null ? y : tick.centerY, view, target);
        if (position === null) return false;
        const degree = degreeForPosition(position);
        // 闸门：音级没变就不发声。指针停在原处（哪怕手抖出几十个 pointermove、
        // 哪怕宿主在重渲染、哪怕刻度节点被虚拟滚动回收）都不会重复响。
        if (force !== true && degree !== null && degree === lastDegree) {
          skippedByDegree += 1;
          lastSkip = { reason: 'degree', at: Date.now(), degree, tick: Number.isFinite(index) ? index : null, source };
          return false;
        }
        const accepted = env.signal(position, source, Number.isFinite(index) ? index : null, force === true ? { repeat: true } : undefined);
        if (accepted === true) {
          acceptedCount += 1;
          if (degree !== null) lastDegree = degree;
          lastTickIndex = Number.isFinite(index) ? index : null;
          lastPosition = position;
        }
        return accepted === true;
      }

      function onPointerDown(event) {
        env.arm();
        const nav = hit(event.target);
        if (nav === null) return;
        dragging = true;
        activeNav = nav;
        activeScroller = scrollerForCached(nav);
        // 按下是明确手势：即使指针正停在同一刻度上，也再响一声作为确认。
        emit(nav, event.clientY, 'slide', activeScroller, true);
      }

      function onPointerMove(event) {
        if (dragging) {
          const nav = activeNav !== null && activeNav.isConnected !== false ? activeNav : hit(event.target);
          if (nav === null) return;
          // 这一支不走 hit()，待决的「离开」倒计时不会被取消；不显式取消的话，
          // 倒计时会在拖拽中途清掉锚点，同一音级被当成「离开后又进入」而重放。
          cancelOffRailReset();
          emit(nav, event.clientY, 'slide', activeScroller);
          return;
        }
        // 未按键的光标划过同样发声：这是桌面端「竖向滑动」的形态。
        const nav = hit(event.target);
        if (nav === null) {
          // 不再立刻清锚点：重渲染 / 预览气泡会让 target 短暂落到导轨之外，
          // 立刻清锚点会把「同一刻度轻微移动」误判成「离开后再进入」而重复发声。
          scheduleOffRailReset('move-off-rail');
          return;
        }
        const scroller = scrollerForCached(nav);
        // 预览气泡等导轨刻度区之外的地方不发声，避免阅读预览时被音高带着走。
        if (scroller !== null && scroller.contains(event.target) === false) {
          scheduleOffRailReset('move-outside-scroller');
          return;
        }
        emit(nav, event.clientY, 'hover', scroller);
      }

      function onPointerOut(event) {
        // 指针离开这条导轨：同样走延迟确认（蹭到悬停预览气泡时 relatedTarget 也在
        // nav 之外，立刻清锚点会造成同样的重放）。
        // relatedTarget 为 null 通常是宿主重渲染顶掉了节点，更不能当作「离开」。
        const nav = railNavFrom(event.target);
        if (nav === null) return;
        const related = event.relatedTarget;
        if (related === null || related === undefined) return;
        let stillInside = false;
        try {
          stillInside = typeof related.closest === 'function' && related.closest('nav') === nav;
        } catch (error) {
          stillInside = false;
        }
        if (!stillInside) scheduleOffRailReset('pointer-out');
      }

      function endDrag() {
        dragging = false;
        activeNav = null;
        activeScroller = null;
      }

      function onClick(event) {
        // 指针点击已在 pointerdown 发声；detail === 0 表示键盘激活。
        if (event.detail !== 0) return;
        const nav = hit(event.target);
        if (nav === null) return;
        const tick = closestTick(event.target);
        const y = tick === null ? event.clientY : centerY(tick);
        if (y === null) return;
        // 键盘激活是明确手势：即便与上一声同音级也给出确认音。
        emit(nav, y, 'click', undefined, true);
      }

      function onWheel(event) {
        const nav = hit(event.target);
        if (nav === null) return;
        const y = event.clientY;
        if (wheelTimer !== null) {
          clearTimeout(wheelTimer);
          wheelTimer = null;
        }
        wheelTimer = setTimeout(() => {
          wheelTimer = null;
          if (disposed || nav.isConnected === false) return;
          const tick = tickAt(nav, y);
          if (tick === null) return;
          emit(nav, tick.centerY, 'wheel', scrollerForCached(nav));
        }, WHEEL_SETTLE_MS);
      }

      document.addEventListener('pointerdown', onPointerDown, options);
      document.addEventListener('pointermove', onPointerMove, options);
      document.addEventListener('pointerup', endDrag, options);
      document.addEventListener('pointercancel', endDrag, options);
      document.addEventListener('pointerout', onPointerOut, options);
      document.addEventListener('click', onClick, options);
      document.addEventListener('wheel', onWheel, options);
      view.addEventListener('blur', endDrag, true);

      return {
        railSeen() {
          return railSeen;
        },
        /** 诊断：去重状态与计数，用来判断「为什么这一声被允许 / 被跳过」。 */
        stats() {
          return {
            accepted: acceptedCount,
            skippedByDegree,
            lastDegree,
            lastTickIndex,
            lastPosition,
            lastSkip,
            resets,
            lastReset,
            offRailPending: offRailTimer !== null,
            railKnown: lastNav !== null && lastNav.isConnected !== false,
          };
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          document.removeEventListener('pointerdown', onPointerDown, options);
          document.removeEventListener('pointermove', onPointerMove, options);
          document.removeEventListener('pointerup', endDrag, options);
          document.removeEventListener('pointercancel', endDrag, options);
          document.removeEventListener('pointerout', onPointerOut, options);
          document.removeEventListener('click', onClick, options);
          document.removeEventListener('wheel', onWheel, options);
          view.removeEventListener('blur', endDrag, true);
          cancelOffRailReset();
          if (wheelTimer !== null) clearTimeout(wheelTimer);
          wheelTimer = null;
          endDrag();
        },
      };
    }

    /* ------------------------------------------------------------------ *
     * 设置区（settings.section 槽位，自写控件）                           *
     * ------------------------------------------------------------------ */

    const CARD_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
      padding: '14px 16px',
      border: '1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, 0.24))',
      borderRadius: '12px',
      fontSize: '13px',
      lineHeight: 1.5,
      color: 'inherit',
    };
    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '16px',
    };
    const TEXT_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 };
    const TITLE_STYLE = { fontSize: '13px', fontWeight: 600 };
    const DESC_STYLE = { fontSize: '12px', opacity: 0.66 };
    const CONTROL_STYLE = { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' };
    const SLIDER_STYLE = { width: '140px', accentColor: 'var(--dsw-alias-brand-primary, #4d6bfe)' };
    const VALUE_STYLE = { fontSize: '12px', opacity: 0.66, minWidth: '36px', textAlign: 'right' };
    const BUTTON_STYLE = {
      padding: '4px 12px',
      fontSize: '12px',
      borderRadius: '8px',
      cursor: 'pointer',
      color: 'inherit',
      border: '1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, 0.35))',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
    };
    const VERSION_STYLE = { fontSize: '11px', opacity: 0.45 };

    /** 把一个异常压成一行可上报的文本（消息 + 栈顶三行）。 */
    function describeError(error) {
      if (error === null || error === undefined) return 'unknown';
      let message = '';
      try {
        message = error.message === undefined ? String(error) : String(error.message);
      } catch (inner) {
        message = 'unprintable';
      }
      let where = '';
      try {
        if (typeof error.stack === 'string') where = error.stack.split('\n').slice(0, 3).join(' | ');
      } catch (inner) {
        where = '';
      }
      return (where === '' ? message : `${message} @ ${where}`).slice(0, 600);
    }

    function registerSettingsSection(ctx, deps) {
      const state = deps.state;
      const controller = deps.controller;
      const status = {
        react: false,
        reactError: null,
        slots: false,
        injected: false,
        registered: false,
        attempts: 0,
        error: null,
        retriesLeft: 0,
      };

      // 服务就绪检查：客户端这一行可能早于 `slots` 服务提供者激活，
      // 此时 `ctx.slots` 是 undefined —— 直接抛错会把整条注册链打断，
      // 所以先判定、记状态、返回（调用方会通过 ctx.inject 等到服务就绪后重来）。
      if (ctx.slots === undefined || ctx.slots === null || typeof ctx.slots.register !== 'function') {
        status.error = 'slots service is not available on this context yet';
        return status;
      }
      status.slots = true;

      // 取 React 单独兜底：这一步失败过就再也没机会说话，所以必须记下原文。
      let React = null;
      try {
        React = require('react');
      } catch (error) {
        React = null;
        status.reactError = describeError(error);
      }
      if (React === null || React === undefined || typeof React.createElement !== 'function') {
        if (status.reactError === null) status.reactError = 'require("react") returned no createElement';
        return status;
      }
      status.react = true;
      const h = React.createElement;

      let translate = (key) => (MESSAGES.zh[key] === undefined ? key : MESSAGES.zh[key]);
      let locale = null;
      try {
        locale = typeof ctx.get === 'function' ? ctx.get('locale') : null;
      } catch (error) {
        locale = null;
      }
      // 服务未就绪时 ctx.get 返回的是 undefined 而不是 null：只判 `!== null` 会穿过去，
      // 下一句读 locale.register 就抛 TypeError，把整条注册链打断（设置卡片永久丢失）。
      if (
        locale !== null &&
        locale !== undefined &&
        typeof locale.register === 'function' &&
        typeof locale.bind === 'function'
      ) {
        try {
          ctx.effect(() => locale.register('rail-tones', MESSAGES), 'dsh-rail-tones: dictionaries');
          const bound = locale.bind('rail-tones');
          if (typeof bound === 'function') {
            translate = (key) => {
              try {
                const value = bound(key);
                if (typeof value === 'string' && value !== '') return value;
              } catch (error) {
                /* 落到内置中文 */
              }
              return MESSAGES.zh[key] === undefined ? key : MESSAGES.zh[key];
            };
          }
        } catch (error) {
          /* 保留内置中文兜底 */
        }
      }
      const t = translate;

      function Switch(props) {
        const on = props.checked === true;
        return h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': on ? 'true' : 'false',
            'aria-label': props.label,
            onClick: props.onToggle,
            style: {
              position: 'relative',
              width: '40px',
              height: '22px',
              flex: '0 0 auto',
              padding: 0,
              borderRadius: '999px',
              cursor: 'pointer',
              border: '1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, 0.35))',
              background: on
                ? 'var(--dsw-alias-brand-primary, #4d6bfe)'
                : 'var(--dsw-alias-bg-neutral, rgba(127, 127, 127, 0.25))',
              transition: 'background 120ms ease',
            },
          },
          h('span', {
            'aria-hidden': true,
            style: {
              position: 'absolute',
              top: '2px',
              left: on ? '20px' : '2px',
              width: '16px',
              height: '16px',
              borderRadius: '50%',
              background: '#fff',
              boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
              transition: 'left 120ms ease',
            },
          }),
        );
      }

      function Row(props) {
        return h('div', { style: ROW_STYLE }, [
          h('div', { key: 'text', style: TEXT_STYLE }, [
            h('div', { key: 'title', style: TITLE_STYLE }, props.title),
            props.description === undefined || props.description === null
              ? null
              : h('div', { key: 'desc', style: DESC_STYLE }, props.description),
          ]),
          h('div', { key: 'control', style: CONTROL_STYLE }, props.children),
        ]);
      }

      function RailToneSettings() {
        const [snapshot, setSnapshot] = React.useState(state.get());
        React.useEffect(() => state.subscribe(setSnapshot), []);
        const enabled = snapshot.enabled === true;
        const preview = () => {
          if (state.get().enabled !== true) return;
          controller.reset();
          controller.signal(0.5, 'preview');
        };
        return h('div', { style: CARD_STYLE }, [
          h(
            Row,
            { key: 'enabled', title: t('title'), description: t('desc') },
            h(Switch, {
              checked: enabled,
              label: t('switchLabel'),
              onToggle: () => state.set({ enabled: !enabled }),
            }),
          ),
          h(Row, { key: 'volume', title: t('volume'), description: t('volumeDesc') }, [
            h('input', {
              key: 'slider',
              type: 'range',
              min: 0, // 下限 0 = 无声
              max: MAX_VOLUME * 100, // 上限 = 100%
              step: 5,
              value: Math.round(snapshot.volume * 100),
              'aria-label': t('volume'),
              onChange: (event) => state.set({ volume: Number(event.target.value) / 100 }),
              style: SLIDER_STYLE,
            }),
            h('span', { key: 'value', style: VALUE_STYLE }, `${Math.round(snapshot.volume * 100)}%`),
          ]),
          h(
            Row,
            { key: 'voice', title: t('voice'), description: t('voiceDesc') },
            h(Switch, {
              checked: snapshot.voice === VOICES.piano,
              label: t('voice'),
              onToggle: () =>
                state.set({ voice: state.get().voice === VOICES.piano ? VOICES.sine : VOICES.piano }),
            }),
          ),
          h(
            Row,
            { key: 'preview', title: t('preview'), description: t('previewDesc') },
            h('button', { type: 'button', onClick: preview, style: BUTTON_STYLE }, t('previewButton')),
          ),
          // 版本号显示在界面上：升级后一眼就能确认浏览器里跑的是哪一版。
          h('div', { key: 'version', style: VERSION_STYLE }, `dsh-rail-tones v${VERSION}`),
        ]);
      }

      // 注册槽位。
      //
      // `slots.register()` 在「槽位尚未被父级声明」时会抛错（slot "…" is not declared）；
      // 而 `slots.inject()` 在槽位**已声明**时会同步调用回调、回调抛错就同步往外抛。
      // 启动时序两种都可能撞上，于是：inject 与 register 各自做有界重试，错误原文全部记录。
      const notify = typeof deps.onChange === 'function' ? deps.onChange : () => {};
      let injectTimer = null;
      let registerTimer = null;

      function tryRegister() {
        if (status.registered) return true;
        status.attempts += 1;
        try {
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'rail-tones',
              order: 45,
              label: () => t('title'),
              locale: 'rail-tones',
              inject: () => ({}),
            },
            RailToneSettings,
          );
          status.registered = true;
          status.error = null;
          status.retriesLeft = 0;
          notify('settings-registered');
          return true;
        } catch (error) {
          status.error = describeError(error);
          return false;
        }
      }

      function scheduleRegisterRetry(remaining) {
        if (registerTimer !== null) clearTimeout(registerTimer);
        status.retriesLeft = remaining;
        registerTimer = setTimeout(() => {
          registerTimer = null;
          if (tryRegister()) return;
          if (remaining > 1) {
            scheduleRegisterRetry(remaining - 1);
            return;
          }
          notify('settings-failed');
        }, SETTINGS_RETRY_MS);
      }

      function onOwnerDeclared() {
        status.injected = true;
        if (tryRegister()) return;
        scheduleRegisterRetry(12);
      }

      function tryInject() {
        try {
          ctx.slots.inject('settings.section', onOwnerDeclared);
          // 成功路径不清 status.error：inject 是同步回调，onOwnerDeclared → tryRegister
          // 若失败已经写好了失败原文，这里清掉会让诊断字段说谎（error: null 但没注册上）。
          return true;
        } catch (error) {
          status.error = describeError(error);
          return false;
        }
      }

      function scheduleInjectRetry(remaining) {
        status.retriesLeft = remaining;
        if (injectTimer !== null) clearTimeout(injectTimer);
        injectTimer = setTimeout(() => {
          injectTimer = null;
          if (tryInject()) return;
          if (remaining > 1) {
            scheduleInjectRetry(remaining - 1);
            return;
          }
          notify('settings-failed');
        }, SETTINGS_RETRY_MS);
      }

      if (!tryInject()) scheduleInjectRetry(45);

      ctx.effect(() => () => {
        if (injectTimer !== null) clearTimeout(injectTimer);
        if (registerTimer !== null) clearTimeout(registerTimer);
        injectTimer = null;
        registerTimer = null;
      });

      return status;
    }

    /* ------------------------------------------------------------------ *
     * 模块导出                                                            *
     * ------------------------------------------------------------------ */

    const name = 'dsh-rail-tones';
    const inject = ['slots'];

    function apply(ctx) {
      const view = window;
      let reported = false;

      function reportOnce(error) {
        if (reported) return;
        reported = true;
        try {
          console.warn('[dsh-rail-tones] 初始化失败，已停用：', error);
        } catch (ignored) {
          /* 控制台不可用 */
        }
      }

      try {
        const state = createState(safeStorage(view));
        const engine = createEngine({
          AudioContext:
            typeof view.AudioContext === 'function'
              ? view.AudioContext
              : typeof view.webkitAudioContext === 'function'
                ? view.webkitAudioContext
                : null,
          volume: () => state.get().volume,
          voice: () => state.get().voice,
        });
        let lastTick = null;
        const recent = [];
        const controller = createController({
          play: (hz, meta) => {
            lastTick = meta !== null && meta !== undefined && meta.tick !== null ? meta.tick : null;
            recent.push({
              at: Date.now(),
              hz: Math.round(hz * 100) / 100,
              source: meta === null || meta === undefined ? null : meta.source,
              tick: lastTick,
              degree: meta === null || meta === undefined ? null : meta.degree,
            });
            if (recent.length > 20) recent.shift();
            engine.play(hz);
          },
          now: () => Date.now(),
          isEnabled: () => state.get().enabled,
        });

        // 诊断：统计同时存活的实例数（>1 说明有重复挂载的监听，会双响/反复响）。
        const instances = (() => {
          try {
            const registry = view.__dshRailTonesInstances === undefined ? { count: 0 } : view.__dshRailTonesInstances;
            registry.count += 1;
            view.__dshRailTonesInstances = registry;
            return registry;
          } catch (error) {
            return { count: 1 };
          }
        })();

        const runtime = { listeners: null };
        // 单实例闸门：市场禁用/启用走的是热挂载（不刷新页面），若上一份实例没被销毁，
        // 同一个指针动作会被多份监听各响一遍。这里在挂载前先掐掉页面上残留的那一份。
        let settings = null;
        let settingsFailure = null;
        let debug = null;
        let disposedAll = false;
        const disposeAll = () => {
          if (disposedAll) return;
          disposedAll = true;
          if (runtime.listeners !== null) {
            runtime.listeners.dispose();
            runtime.listeners = null;
          }
          engine.dispose();
          try {
            instances.count = Math.max(0, instances.count - 1);
          } catch (error) {
            /* 忽略 */
          }
          try {
            if (view.__dshRailTones === debug) delete view.__dshRailTones;
          } catch (error) {
            /* 忽略 */
          }
          try {
            if (view.__dshRailTonesActive === record) delete view.__dshRailTonesActive;
          } catch (error) {
            /* 忽略 */
          }
        };
        const record = { version: VERSION, dispose: disposeAll };
        try {
          const previous = view.__dshRailTonesActive;
          if (previous !== undefined && previous !== null && typeof previous.dispose === 'function') previous.dispose();
        } catch (error) {
          /* 忽略 */
        }

        ctx.effect(() => {
          runtime.listeners = attachRailListeners({
            view,
            arm: () => engine.arm(),
            // 必须把控制器的返回值交回去：emit 靠它更新监听层的音级锚点，
            // 吞掉返回值会让「同音级不重响」的闸门形同虚设（v0.1.10 在真实会话中复现过）。
            signal: (position, source, tick, options) =>
              controller.signal(position, source, tick, options),
          });
          try {
            view.__dshRailTonesActive = record;
          } catch (error) {
            /* 忽略 */
          }
          return disposeAll;
        });

        // 任意一次用户手势都预热音频上下文，避免「先滚轮、后点击」时第一次无声。
        ctx.effect(() => {
          const arm = () => engine.arm();
          const options = { capture: true, passive: true, once: true };
          view.addEventListener('pointerdown', arm, options);
          view.addEventListener('keydown', arm, options);
          return () => {
            view.removeEventListener('pointerdown', arm, { capture: true });
            view.removeEventListener('keydown', arm, { capture: true });
          };
        });

        // 自报通道（宿主半边提供 /rail-tones/status 与 /rail-tones/report）：
        // 让「重启后到底有没有挂载、槽位注册成没成」变成一条终端可读的记录。
        const report = (reason) => {
          try {
            const payload = JSON.stringify({
              reason,
              version: VERSION,
              at: new Date().toISOString(),
              href: view.location === undefined || view.location === null ? null : String(view.location.href),
              instances: instances.count,
              settingsFailure,
              settings:
                settings === null || settings === undefined
                  ? null
                  : {
                      react: settings.react,
                      reactError: settings.reactError,
                      slots: settings.slots,
                      injected: settings.injected,
                      registered: settings.registered,
                      attempts: settings.attempts,
                      error: settings.error,
                      retriesLeft: settings.retriesLeft,
                    },
              rails: debug === null ? null : debug.rails(),
              audio: engine.state(),
              dedup: runtime.listeners === null ? null : runtime.listeners.stats(),
            });
            // 文档相对形式：页面的 baseURI 是 dsh-app://app/，宿主会把它代理到本机
            // webserver 的 /rail-tones/report（与官方 open-in-app 客户端同一约定）。
            const pending = view.fetch('rail-tones/report', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: payload,
            });
            if (pending !== null && pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {});
          } catch (error) {
            /* 自报失败绝不影响功能 */
          }
        };

        // 设置卡片：依赖的服务在客户端是「后到」的 —— 我们这一行在组合脚本里排在
        // `dshmarket` 等之前，模块级 `inject: ['slots']` 在这条路径上并不保证等到服务就绪
        // （实测 apply 时 ctx.slots === undefined，整条注册链因此抛错、卡片永久丢失）。
        // 两层保险：① cordis 作用域注入 ctx.inject(['slots'], …) 等服务就绪；
        // ② 无论拿到 slots === false 的状态还是整条注册抛错，都按 SETTINGS_RETRY_MS 有界重试
        //    —— 服务就绪是竞态，一次失败就放弃等于把卡片永久丢掉。
        let settingsTimer = null;
        let settingsTries = 0;
        const stopSettingsRetry = () => {
          if (settingsTimer !== null) clearTimeout(settingsTimer);
          settingsTimer = null;
        };
        const scheduleSettingsRetry = () => {
          stopSettingsRetry();
          settingsTimer = setTimeout(() => {
            settingsTimer = null;
            startSettings(undefined);
          }, SETTINGS_RETRY_MS);
        };

        const startSettings = (scoped) => {
          const target = scoped === undefined || scoped === null ? ctx : scoped;
          settingsTries += 1;
          const exhausted = settingsTries >= SETTINGS_MAX_TRIES;
          try {
            settings = registerSettingsSection(target, {
              state,
              controller,
              onChange: (why) => report(why),
            });
          } catch (error) {
            settingsFailure = describeError(error);
            reportOnce(error);
            if (exhausted) {
              report('settings-gave-up');
              return;
            }
            // 只在第一次失败时上报：重试期间不刷屏，成功/放弃都会各自再报一次。
            if (settingsTries === 1) report('settings-threw');
            scheduleSettingsRetry();
            return;
          }
          if (settings !== null && settings !== undefined && settings.slots === false) {
            if (exhausted) report('settings-gave-up');
            else scheduleSettingsRetry();
          }
        };

        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['slots'], startSettings);
          } else {
            startSettings(ctx);
          }
        } catch (error) {
          settingsFailure = describeError(error);
          reportOnce(error);
          report('settings-threw');
        }
        ctx.effect(() => stopSettingsRetry);

        const debugApi = {
          version: VERSION,
          status: () => {
            const listenerStats = runtime.listeners === null ? null : runtime.listeners.stats();
            return {
              ...state.get(),
              version: VERSION,
              instances: instances.count,
              notesPlayed: controller.stats().notesPlayed,
              lastNoteHz: controller.stats().lastHz,
              lastTick,
              railSeen: runtime.listeners === null ? false : runtime.listeners.railSeen(),
              audioState: engine.state(),
              dedup: listenerStats,
              settingsFailure,
              settings:
                settings === null || settings === undefined
                  ? { react: null, slots: null, injected: false, registered: false, attempts: 0, error: 'not attempted' }
                  : {
                      react: settings.react,
                      reactError: settings.reactError,
                      slots: settings.slots,
                      injected: settings.injected,
                      registered: settings.registered,
                      attempts: settings.attempts,
                      error: settings.error,
                    },
            };
          },
          /** 最近 N 次真正发声的记录（含 source / tick / degree）。 */
          log: (limit) => {
            const size = Number.isFinite(limit) && limit > 0 ? Math.min(20, Math.floor(limit)) : 10;
            return recent.slice(-size);
          },
          /** 诊断用：列出页面上所有「含刻度按钮的 nav」，标出哪一个被当作导轨。 */
          rails: () => {
            const found = [];
            let all = null;
            try {
              all = view.document.querySelectorAll('nav');
            } catch (error) {
              return found;
            }
            for (const nav of all) {
              const tick = typeof nav.querySelector === 'function' ? nav.querySelector(TICK_SELECTOR) : null;
              if (tick === null) continue;
              let owner = null;
              try {
                owner = typeof tick.closest === 'function' ? tick.closest('nav') : null;
              } catch (error) {
                owner = null;
              }
              let rect = null;
              try {
                rect = nav.getBoundingClientRect();
              } catch (error) {
                rect = null;
              }
              found.push({
                used: owner === nav,
                ticks: nav.querySelectorAll(TICK_SELECTOR).length,
                width: rect === null ? null : Math.round(rect.width),
                height: rect === null ? null : Math.round(rect.height),
              });
            }
            return found;
          },
          setEnabled: (value) => {
            state.set({ enabled: value === true });
            return state.get().enabled;
          },
          setVolume: (value) => {
            const volume = Math.min(MAX_VOLUME, Math.max(0, Number(value) || 0));
            state.set({ volume });
            return volume;
          },
          setVoice: (value) => {
            const voice = normalizeVoice(value) === null ? DEFAULTS.voice : value;
            state.set({ voice });
            return state.get().voice;
          },
          play: (position) => controller.signal(typeof position === 'number' ? position : 0.5, 'debug'),
          /** 手动把当前状态上报给宿主半边（写入 ~/.dsh/rail-tones-report.json）。 */
          report: (reason) => report(typeof reason === 'string' ? reason : 'manual'),
        };
        debug = debugApi;
        try {
          view.__dshRailTones = debugApi;
        } catch (error) {
          /* 只读全局，忽略 */
        }
        report('mount');

        ctx.effect(() => disposeAll);
      } catch (error) {
        reportOnce(error);
      }
    }

    return {
      name,
      inject,
      apply,
      __internals: {
        SCALE,
        DEGREES,
        DEFAULTS,
        MAX_VOLUME,
        PEAK_FACTOR,
        VOICES,
        PIANO_WEIGHTS,
        PIANO_WEIGHT_SUM,
        PIANO_TAUS,
        PIANO_INHARM,
        PIANO_DECAY_S,
        PIANO_PEAK_SCALE,
        normalizeVoice,
        STORE_KEY,
        degreeForPosition,
        noteHz,
        positionFrom,
        preferTick,
        createController,
        createState,
        createEngine,
        attachRailListeners,
        registerSettingsSection,
      },
    };
  },
});
