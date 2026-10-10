/**
 * dsh-rail-tones 的单元测试（node --test）。
 *
 * 覆盖范围（按 DSH 的 verification 约定）：
 * - client.js 这一份「真实产物」的清单契约与其导出的纯逻辑（音级映射、几何换算、
 *   发声调度状态机、设置存储）；
 * - 不模拟 React / 浏览器 DOM：宿主交互由真机（DSH Desktop）验收，测试只证明
 *   可确定的部分。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientPath = join(root, 'client.js');

/** 以「浏览器里那样」的入口载入 client.js，并取回它注册的工厂与模块导出。 */
const loaded = (async () => {
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition;
      },
    },
  };
  await import(pathToFileURL(clientPath).href);
  assert.ok(captured !== null, 'client.js 必须通过 window.__ModuleLoader__.load 注册工厂');
  const definition = captured;
  const mod = definition.factory(() => {
    throw new Error('测试中不应 require 任何浏览器模块');
  });
  return { definition, mod, internals: mod.__internals };
})();

function memoryStorage(initial) {
  const map = new Map(initial === undefined ? [] : Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    raw: map,
  };
}

/** 工厂无副作用，可以用不同的 require 再取一份模块导出。 */
async function moduleWith(requireImpl) {
  const { definition } = await loaded;
  return definition.factory(requireImpl);
}

const reactRequire = (id) => {
  if (id !== 'react') throw new Error(`测试中不应 require ${id}`);
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  };
};

/** 假 ctx：slots 已就绪、effect 立即执行并收集清理函数（测试结束调用 dispose 清定时器）。 */
function fakeCtx(options) {
  const settings = options === undefined ? {} : options;
  const cleanups = [];
  const ctx = {
    slots: {
      register: settings.register === undefined ? () => {} : settings.register,
      inject: (key, callback) => {
        callback();
      },
    },
    get: (name) => (name === 'locale' ? settings.locale : undefined),
    effect: (fn) => {
      const dispose = typeof fn === 'function' ? fn() : undefined;
      if (typeof dispose === 'function') cleanups.push(dispose);
      return () => {};
    },
  };
  ctx.inject = (deps, callback) => callback(ctx);
  ctx.dispose = () => {
    for (const fn of cleanups.splice(0)) fn();
  };
  return ctx;
}

const TICK = 'button[data-index]';

/**
 * 最小导轨 DOM，照官方结构搭：nav > div(滚动容器) > div > button[data-index]…。
 * 只实现被测代码真正会碰的那几个方法。
 */
function makeRail(options) {
  const config = options === undefined ? {} : options;
  const tickCount = config.ticks === undefined ? 5 : config.ticks;
  const tickHeight = config.tickHeight === undefined ? 10 : config.tickHeight;
  const top = config.top === undefined ? 0 : config.top;

  function matches(el, selector) {
    if (selector === 'nav') return el.tagName === 'nav';
    if (selector === TICK) return el.tagName === 'button' && el.getAttribute('data-index') !== null;
    return false;
  }

  function node(tagName, parent) {
    const self = {
      tagName,
      parentElement: parent === undefined ? null : parent,
      isConnected: true,
      attrs: {},
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(self.attrs, name) ? self.attrs[name] : null;
      },
      closest(selector) {
        let current = self;
        while (current !== null) {
          if (matches(current, selector)) return current;
          current = current.parentElement;
        }
        return null;
      },
      getBoundingClientRect: () => ({ top: 0, height: 0, width: 0 }),
    };
    return self;
  }

  const nav = node('nav');
  const scroller = node('div', nav);
  scroller.scrollTop = 0;
  scroller.clientHeight = tickCount * tickHeight;
  scroller.scrollHeight = scroller.clientHeight * 4; // 内容高于视口 → 认定为可滚动容器
  scroller.getBoundingClientRect = () => ({ top, height: scroller.clientHeight, width: 12 });
  const marks = node('div', scroller);
  const ticks = [];
  for (let index = 0; index < tickCount; index += 1) {
    const tick = node('button', marks);
    tick.attrs['data-index'] = String(index);
    tick.getBoundingClientRect = () => ({ top: top + index * tickHeight, height: tickHeight, width: 12 });
    ticks.push(tick);
  }
  scroller.contains = (el) => el === scroller || el === marks || ticks.includes(el);
  nav.querySelectorAll = (selector) => (selector === TICK ? ticks.slice() : []);
  nav.querySelector = (selector) => (selector === TICK && ticks.length > 0 ? ticks[0] : null);

  // 导轨之外的元素（悬停预览气泡就是这一类：relatedTarget 非空但不在 nav 内）。
  const outside = node('div');

  const handlers = new Map();
  const view = {
    document: {
      addEventListener(type, fn) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        const set = handlers.get(type);
        if (set !== undefined) set.delete(fn);
      },
      querySelectorAll: () => [],
    },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: (el) => ({ overflowY: el === scroller ? 'auto' : 'visible' }),
  };

  return {
    view,
    nav,
    scroller,
    ticks,
    outside,
    dispatch(type, event) {
      const set = handlers.get(type);
      if (set === undefined) return;
      for (const fn of Array.from(set)) fn(event);
    },
  };
}

/** 接上监听层，把每次 signal 的参数原样记下来。 */
async function startRail(rail) {
  const { attachRailListeners } = (await moduleWith(reactRequire)).__internals;
  const calls = [];
  const listeners = attachRailListeners({
    view: rail.view,
    arm() {},
    signal: (position, source, tick, options) => {
      calls.push({ position, source, tick, options });
      return true;
    },
  });
  return { listeners, calls };
}

/**
 * 走完整 `apply`：真 effect、假 DOM、假 fetch。
 * 用来盯「接线」——纯逻辑各自都对、但参数在中间被丢掉的那类缺陷
 * （repeat 曾经就丢在 apply 的 signal 适配器里）。
 */
async function bootPlugin(options) {
  const config = options === undefined ? {} : options;
  const mod = await moduleWith(reactRequire);
  const rail = makeRail();
  // apply 里 `view = window`，所以导轨 DOM 要装到全局 window 上。
  Object.assign(globalThis.window, rail.view);
  globalThis.window.location = { href: 'dsh-app://app/' };
  globalThis.window.localStorage = memoryStorage();
  const reports = [];
  globalThis.window.fetch = (url, init) => {
    reports.push(JSON.parse(init.body));
    return Promise.resolve();
  };

  const registered = [];
  const ctx = {
    slots: {
      register: (spec) => {
        registered.push(spec);
      },
      inject: (key, callback) => {
        callback();
      },
    },
    get: () => undefined,
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  ctx.inject = (deps, callback) => callback(ctx);

  // breakSlots：让 slots 的读取抛错，模拟「注册链整体炸掉」（slot 服务未就绪时的抛错形态）。
  let broken = config.breakSlots === true;
  if (broken) {
    const realSlots = ctx.slots;
    delete ctx.slots;
    Object.defineProperty(ctx, 'slots', {
      configurable: true,
      get() {
        if (broken) throw new Error('slots exploded');
        return realSlots;
      },
    });
  }

  mod.apply(ctx);
  return {
    rail,
    reports,
    registered,
    debug: () => globalThis.window.__dshRailTones,
    heal: () => {
      broken = false;
    },
    shutdown: () => {
      const active = globalThis.window.__dshRailTonesActive;
      if (active !== undefined && active !== null) active.dispose();
    },
  };
}

test('模块契约：id、name、inject、apply', async () => {
  const { definition, mod } = await loaded;
  assert.equal(definition.id, 'dsh-rail-tones');
  assert.equal(typeof definition.factory, 'function');
  assert.equal(mod.name, 'dsh-rail-tones');
  assert.deepEqual(mod.inject, ['slots']);
  assert.equal(typeof mod.apply, 'function');
});

test('音级映射：位置 → 音级（含钳制与非法输入）', async () => {
  const { degreeForPosition, DEGREES } = (await loaded).internals;
  assert.equal(DEGREES, 10);
  assert.equal(degreeForPosition(0), 0);
  assert.equal(degreeForPosition(1), DEGREES - 1);
  assert.equal(degreeForPosition(-5), 0);
  assert.equal(degreeForPosition(9), DEGREES - 1);
  assert.equal(degreeForPosition(Number.NaN), null);
  assert.equal(degreeForPosition(undefined), null);
  assert.equal(degreeForPosition('0.5'), null);
});

test('音级映射：整段区间单调不减', async () => {
  const { degreeForPosition } = (await loaded).internals;
  let previous = -1;
  for (let step = 0; step <= 200; step += 1) {
    const degree = degreeForPosition(step / 200);
    assert.ok(degree >= previous, `位置 ${step / 200} 处音级回退`);
    previous = degree;
  }
});

test('音级 → 频率：五声音阶 2 个八度', async () => {
  const { noteHz } = (await loaded).internals;
  assert.equal(noteHz(0), 220); // A3
  assert.equal(noteHz(5), 440); // A4
  assert.ok(Math.abs(noteHz(3) - 329.63) < 0.05); // E4
  assert.ok(Math.abs(noteHz(9) - 739.99) < 0.05); // F#5
  assert.equal(noteHz(-3), 220); // 越界钳制
  assert.equal(noteHz(99), noteHz(9));
  assert.equal(noteHz(Number.NaN), null);
});

test('几何换算：视口坐标 → 导轨内容位置', async () => {
  const { positionFrom } = (await loaded).internals;
  assert.equal(positionFrom({ y: 50, rectTop: 0, scrollTop: 0, scrollHeight: 100 }), 0.5);
  assert.equal(positionFrom({ y: -20, rectTop: 0, scrollTop: 0, scrollHeight: 100 }), 0);
  assert.equal(positionFrom({ y: 500, rectTop: 0, scrollTop: 0, scrollHeight: 100 }), 1);
  assert.equal(positionFrom({ y: 0, rectTop: 0, scrollTop: 100, scrollHeight: 200 }), 0.5);
  assert.equal(positionFrom({ y: 10, rectTop: 10, scrollTop: 45, scrollHeight: 100 }), 0.45);
  assert.equal(positionFrom({ y: 10, rectTop: 0, scrollTop: 0, scrollHeight: 0 }), null);
  assert.equal(positionFrom({ y: Number.NaN, rectTop: 0, scrollTop: 0, scrollHeight: 100 }), null);
  assert.equal(positionFrom(null), null);
});

test('调度器：节流、同音级去重、开关与非法位置', async () => {
  const { createController, noteHz } = (await loaded).internals;
  const played = [];
  let clock = 0;
  let enabled = true;
  const controller = createController({
    play: (hz, meta) => played.push({ hz, ...meta }),
    now: () => clock,
    isEnabled: () => enabled,
  });

  assert.equal(controller.signal(0, 'slide'), true); // t=0，音级 0
  assert.equal(played.length, 1);
  assert.equal(played[0].hz, 220);
  assert.equal(played[0].source, 'slide');

  clock = 40; // 未达最小间隔
  assert.equal(controller.signal(1, 'slide'), false);

  clock = 100; // 间隔足够且音级不同
  assert.equal(controller.signal(1, 'slide'), true);
  assert.equal(played[1].hz, noteHz(9));

  clock = 150; // 同音级且在去重窗口内
  assert.equal(controller.signal(1, 'slide'), false);

  clock = 400; // 同音级但已超出窗口
  assert.equal(controller.signal(1, 'slide'), true);
  assert.equal(controller.stats().notesPlayed, 3);

  enabled = false;
  clock = 900;
  assert.equal(controller.signal(0.2, 'slide'), false);
  assert.equal(controller.stats().notesPlayed, 3);

  enabled = true;
  assert.equal(controller.signal(Number.NaN, 'slide'), false);

  controller.reset();
  clock = 1000;
  assert.equal(controller.signal(1, 'preview'), true);
  assert.equal(played[3].source, 'preview');
});

test('调度器：明确手势（repeat）可重复同音级，最小间隔仍然生效', async () => {
  const { createController } = (await loaded).internals;
  const played = [];
  let clock = 0;
  const controller = createController({
    play: (hz, meta) => played.push({ hz, ...meta }),
    now: () => clock,
    isEnabled: () => true,
  });

  assert.equal(controller.signal(0.5, 'hover', 3), true); // t=0，音级 5
  clock = 100;
  assert.equal(controller.signal(0.5, 'hover', 3), false); // 同音级 250ms 窗口内
  clock = 600;
  // 窗口已过：控制器允许，但「同一刻度不重复」由监听层的音级闸门 + 刻度滞回负责，
  // 因此指针停在长刻度上轻微抖动不会再次发声（见 README「刻度吸附」）。
  assert.equal(controller.signal(0.5, 'hover', 3), true);

  clock = 650;
  assert.equal(controller.signal(0.5, 'slide', 3, { repeat: true }), false); // 70ms 最小间隔优先
  clock = 800;
  assert.equal(controller.signal(0.5, 'click', 3, { repeat: true }), true); // 点击给出确认音
  assert.equal(controller.stats().notesPlayed, 3);
  assert.equal(played[2].source, 'click');
  assert.equal(played[2].tick, 3);
});

test('刻度吸附滞回：另一个刻度要明显更近才切换', async () => {
  const { preferTick } = (await loaded).internals;
  const a = { centerY: 100, index: 4 }; // 当前吸附的刻度
  const b = { centerY: 110, index: 5 }; // 相邻刻度（~10px 一档）

  // 指针在分界线上（105px）：b 仅近 0px→ 维持 a
  assert.equal(preferTick(b, a, 105, 4), a);
  // b 更近但差距在滞回余量内（y=107：|a|=7, |b|=3，差 4px）→ 仍维持 a
  assert.equal(preferTick(b, a, 107, 4), a);
  // b 明显更近（y=112：|a|=12, |b|=2，差 10px > 4px）→ 切换到 b
  assert.equal(preferTick(b, a, 112, 4), b);
  // 明确走远（y=125）→ 切换到 b
  assert.equal(preferTick(b, a, 125, 4), b);

  // 边界：没有上一轮 → 用 best；本轮没有刻度 → 保留上一轮；同一刻度 → best
  assert.equal(preferTick(b, null, 105, 4), b);
  assert.equal(preferTick(null, a, 105, 4), a);
  assert.equal(preferTick(null, null, 105, 4), null);
  assert.equal(preferTick({ centerY: 101, index: 4 }, a, 105, 4).index, 4);
  // 无有效 y / 无滞回余量时的兜底
  assert.equal(preferTick(b, a, Number.NaN, 4), b);
  assert.equal(preferTick(b, a, 106, 0), b); // margin=0 且 b 严格更近 → 切换
  assert.equal(preferTick(b, a, 105, 0), a); // margin=0 但恰好等距 → 维持原判
});

test('设置存储：默认值、持久化、脏数据与非法音量兜底', async () => {
  const { createState, STORE_KEY, DEFAULTS, MAX_VOLUME } = (await loaded).internals;

  const cold = createState(null);
  assert.deepEqual(cold.get(), { ...DEFAULTS });

  const storage = memoryStorage();
  const state = createState(storage);
  assert.deepEqual(state.get(), { ...DEFAULTS });
  state.set({ enabled: false });
  assert.equal(state.get().enabled, false);
  assert.deepEqual(JSON.parse(storage.raw.get(STORE_KEY)), {
    enabled: false,
    volume: DEFAULTS.volume,
    voice: DEFAULTS.voice,
  });

  const reloaded = createState(storage);
  assert.equal(reloaded.get().enabled, false);

  const dirty = createState(memoryStorage({ [STORE_KEY]: '{ not json' }));
  assert.deepEqual(dirty.get(), { ...DEFAULTS });

  const weird = createState(memoryStorage({ [STORE_KEY]: JSON.stringify({ enabled: 'yes', volume: 42 }) }));
  assert.deepEqual(weird.get(), { enabled: DEFAULTS.enabled, volume: MAX_VOLUME, voice: DEFAULTS.voice });

  const negative = createState(memoryStorage());
  negative.set({ volume: -3 });
  assert.equal(negative.get().volume, 0);

  // 音量范围：下限 0 = 无声，上限 1 = 100%（v0.1.13 起由 200% 收窄）；区间内（含 80%）原样保留。
  // 最大响度较此前翻倍：包络峰值 PEAK_FACTOR 由 0.22 提到 0.88（0%→100% 音量差 = 旧 0%→200% 的 2 倍）。
  const ranged = createState(memoryStorage());
  ranged.set({ volume: 0.8 });
  assert.equal(ranged.get().volume, 0.8);
  ranged.set({ volume: 1 });
  assert.equal(ranged.get().volume, 1);
  ranged.set({ volume: 99 });
  assert.equal(ranged.get().volume, MAX_VOLUME);
  assert.equal(MAX_VOLUME, 1, '音量上限必须是 100%');
  const { PEAK_FACTOR } = (await loaded).internals;
  assert.equal(PEAK_FACTOR, 0.88, '100% 时包络峰值须为旧 200% 峰值 0.44 的 2 倍（音量差翻倍）');
  const stored = createState(memoryStorage({ [STORE_KEY]: JSON.stringify({ enabled: true, volume: 1.5 }) }));
  assert.equal(stored.get().volume, MAX_VOLUME, '存量里越界的旧值（如 150%）读取时钳到 100%');

  const notified = [];
  const unsubscribe = negative.subscribe((value) => notified.push(value));
  negative.set({ enabled: false });
  unsubscribe();
  negative.set({ enabled: true });
  assert.equal(notified.length, 1);
});

test('音色切换：默认正弦、白名单钳制、存量兼容与持久化', async () => {
  const { createState, STORE_KEY, DEFAULTS, VOICES, VOICE_OPTIONS, normalizeVoice } = (await loaded).internals;

  // 注册表：每项有 id/labelKey/descKey，id 唯一，默认 = 第一项；VOICES 由注册表派生。
  const ids = VOICE_OPTIONS.map((option) => option.id);
  assert.ok(Array.isArray(VOICE_OPTIONS) && VOICE_OPTIONS.length >= 3, '注册表至少含 sine 与 piano、chime');
  assert.deepEqual(ids, ['sine', 'piano', 'chime'], '注册表顺序即设置列表顺序');
  assert.equal(new Set(ids).size, ids.length, '注册表 id 不得重复');
  for (const option of VOICE_OPTIONS) {
    assert.equal(typeof option.id, 'string');
    assert.equal(typeof option.labelKey, 'string', '每项必须带文案键（新增音效零 UI 改动的前提）');
    assert.equal(typeof option.descKey, 'string');
    assert.equal(VOICES[option.id], option.id, 'VOICES 派生自注册表');
  }
  assert.equal(DEFAULTS.voice, VOICE_OPTIONS[0].id, '默认音色 = 注册表第一项');
  assert.equal(normalizeVoice('piano'), 'piano');
  assert.equal(normalizeVoice('harp'), null, '注册表外 id → null');

  // 存量数据（v0.2.0 之前）没有 voice 字段 → 读取时回退默认音色，不抛错。
  const legacy = createState(memoryStorage({ [STORE_KEY]: JSON.stringify({ enabled: true, volume: 0.5 }) }));
  assert.equal(legacy.get().voice, DEFAULTS.voice, '缺 voice 字段的存量数据回退默认音色');
  assert.equal(DEFAULTS.voice, 'sine', '默认音色必须仍是 sine（不打扰存量用户听感）');
  assert.equal(VOICES.piano, 'piano');
  assert.equal(normalizeVoice('chime'), 'chime');

  // 切换 → 持久化 → 重载保持。
  const storage = memoryStorage();
  const state = createState(storage);
  state.set({ voice: VOICES.piano });
  assert.equal(state.get().voice, 'piano');
  assert.equal(JSON.parse(storage.raw.get(STORE_KEY)).voice, 'piano', '音色要写进存储');
  assert.equal(createState(storage).get().voice, 'piano', '刷新后保持');
  state.set({ voice: VOICES.sine });
  assert.equal(state.get().voice, 'sine', '切回正弦');

  // 白名单：非法值回退默认；脏数据读取同样回退。
  state.set({ voice: 'violin' });
  assert.equal(state.get().voice, DEFAULTS.voice, '白名单外的音色回退默认');
  const dirty = createState(memoryStorage({ [STORE_KEY]: JSON.stringify({ voice: 42 }) }));
  assert.equal(dirty.get().voice, DEFAULTS.voice);
});

/** 最小假 AudioContext：记录节点创建与参数，够盯住两种音色的合成差异。 */
function fakeAudio() {
  const nodes = { oscillators: [], gains: [] };
  const context = {
    currentTime: 1.5,
    state: 'running',
    destination: { name: 'destination' },
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: { setValueAtTime: (value) => { osc.hz = value; } },
        start() {},
        stop(at) { osc.stopAt = at; },
        connect() {},
        disconnect() {},
        onended: null,
      };
      nodes.oscillators.push(osc);
      return osc;
    },
    createGain() {
      const node = { values: [] };
      node.gain = {
        values: node.values,
        setValueAtTime: (value) => { node.values.push(value); },
        linearRampToValueAtTime: (value) => { node.values.push(value); },
        exponentialRampToValueAtTime: (value) => { node.values.push(value); },
      };
      node.connect = () => {};
      node.disconnect = () => {};
      nodes.gains.push(node);
      return node;
    },
  };
  return { context, nodes };
}

test('音频引擎：正弦单振荡器，钢琴六分音、频率失谐且满幅不削波', async () => {
  const { createEngine, VOICES, PEAK_FACTOR, PIANO_PEAK_SCALE, PIANO_INHARM, PIANO_WEIGHTS, PIANO_WEIGHT_SUM } =
    (await loaded).internals;

  const build = (voice) => {
    const { context, nodes } = fakeAudio();
    const engine = createEngine({
      AudioContext: function FakeAudioContext() { return context; },
      volume: () => 1,
      voice: () => voice,
    });
    return { engine, context, nodes };
  };

  // 正弦（回归保护：v0.2.0 之前的唯一音色，行为必须原样）。
  const sine = build(VOICES.sine);
  assert.equal(sine.engine.play(440), true);
  assert.equal(sine.nodes.oscillators.length, 1, '正弦音恰 1 个振荡器');
  assert.equal(sine.nodes.oscillators[0].hz, 440, '正弦音频率 = 基频');
  const sinePeak = sine.nodes.gains[0].gain.values[1];
  assert.equal(Math.abs(sinePeak - PEAK_FACTOR) < 1e-12, true, '正弦满音量峰值 = PEAK_FACTOR');

  // 钢琴：6 个分音振荡器 + 1 条 master gain。
  const piano = build(VOICES.piano);
  assert.equal(piano.engine.play(440), true);
  assert.equal(piano.nodes.oscillators.length, PIANO_WEIGHTS.length, '钢琴音 = 6 个正弦分音');
  assert.equal(piano.nodes.gains.length, PIANO_WEIGHTS.length + 1, '分音 gain + master gain');
  for (let i = 0; i < PIANO_WEIGHTS.length; i += 1) {
    const n = i + 1;
    const expected = 440 * n * (1 + PIANO_INHARM * n * n);
    assert.ok(
      Math.abs(piano.nodes.oscillators[i].hz - expected) < 1e-6,
      `第 ${n} 分音频率应带失谐：${piano.nodes.oscillators[i].hz} ≈ ${expected}`,
    );
  }
  // master 包络峰值 = 1 × PEAK_FACTOR × PIANO_PEAK_SCALE，且分音权重按 Σ 归一 → 任意时刻 |Σ| ≤ 峰值。
  // （playPiano 先建 master 再建分音 → gains[0] 是 master，gains[i+1] 是第 i 分音。）
  const master = piano.nodes.gains[0];
  const masterPeak = master.gain.values[1];
  assert.ok(Math.abs(masterPeak - PEAK_FACTOR * PIANO_PEAK_SCALE) < 1e-12, 'master 峰值 ≈ 0.704');
  assert.ok(masterPeak < 1, '满音量不削波');
  let weightSum = 0;
  for (let i = 0; i < PIANO_WEIGHTS.length; i += 1) {
    // 分音 gain：setValueAtTime(权重/Σ) + 一条指数衰减到 0.0001。
    const values = piano.nodes.gains[i + 1].gain.values;
    assert.equal(values.length, 2, '分音 gain 应有权重与衰减两拍');
    weightSum += values[0];
    assert.ok(Math.abs(values[0] - PIANO_WEIGHTS[i] / PIANO_WEIGHT_SUM) < 1e-12, `第 ${i + 1} 分音权重归一`);
  }
  assert.ok(Math.abs(weightSum - 1) < 1e-12, '归一后权重和恰为 1');

  // 音量 0 → 两种音色都静音；volume() 抛错也不炸。
  const zero = createEngine({
    AudioContext: function Fake() { return fakeAudio().context; },
    volume: () => 0,
    voice: () => VOICES.piano,
  });
  assert.equal(zero.play(440), false);
  const throwing = createEngine({
    AudioContext: function Fake() { return fakeAudio().context; },
    volume: () => { throw new Error('boom'); },
    voice: () => { throw new Error('boom'); },
  });
  assert.equal(throwing.play(440), false, '取值抛错只静音，不外抛');
});

test('音频引擎：清音 = 主音 + 1.5× 钟类分音 + 上方五度引导音（Σ 归一不削波）', async () => {
  const { createEngine, VOICES, PEAK_FACTOR, CHIME_PEAK_SCALE, CHIME_WEIGHTS, CHIME_WEIGHT_SUM, CHIME_RATIOS, CHIME_LEAD_RATIO, CHIME_LEAD_S, CHIME_ATTACK_S, CHIME_DECAY_S, ATTACK_S } =
    (await loaded).internals;
  const { context, nodes } = fakeAudio();
  const engine = createEngine({
    AudioContext: function Fake() { return context; },
    volume: () => 1,
    voice: () => VOICES.chime,
  });
  assert.equal(engine.play(440), true);
  // 主音分音 + 引导音。
  assert.equal(nodes.oscillators.length, CHIME_WEIGHTS.length + 1, '清音 = 2 个主音分音 + 1 个引导音');
  for (let i = 0; i < CHIME_RATIOS.length; i += 1) {
    assert.ok(
      Math.abs(nodes.oscillators[i].hz - 440 * CHIME_RATIOS[i]) < 1e-6,
      `主音第 ${i + 1} 分音频率 = f0 × ${CHIME_RATIOS[i]}`,
    );
  }
  assert.ok(
    Math.abs(nodes.oscillators[CHIME_RATIOS.length].hz - 440 * CHIME_LEAD_RATIO) < 1e-6,
    '引导音 = 主音 × 1.5（上方五度）',
  );
  assert.equal(nodes.gains.length, nodes.oscillators.length + 1, '分音/引导音 gain + master gain');
  // master 包络：0.0001 → 30ms 线性升峰 → 850ms 指数衰减（软钟音轮廓）。
  const master = nodes.gains[0];
  const masterPeak = master.gain.values[1];
  assert.ok(Math.abs(masterPeak - PEAK_FACTOR * CHIME_PEAK_SCALE) < 1e-12, 'master 峰值 = PEAK_FACTOR × CHIME_PEAK_SCALE');
  assert.ok(masterPeak < 1, '满音量不削波');
  // 主音分音权重按 Σ 归一，和恰为 1。
  let weightSum = 0;
  for (let i = 0; i < CHIME_WEIGHTS.length; i += 1) {
    const values = nodes.gains[i + 1].gain.values;
    assert.equal(values.length, 1, '清音主音分音 gain 恒值（钟类质感全程保留）');
    weightSum += values[0];
    assert.ok(Math.abs(values[0] - CHIME_WEIGHTS[i] / CHIME_WEIGHT_SUM) < 1e-12, `第 ${i + 1} 分音权重归一`);
  }
  assert.ok(Math.abs(weightSum - 1) < 1e-12, '归一后权重和恰为 1');
  // 引导音：软起音 + 40ms 内衰减（复刻琶音末级短音）。
  const leadValues = nodes.gains[CHIME_WEIGHTS.length + 1].gain.values;
  assert.ok(leadValues.length >= 3, '引导音 gain 应有升起与衰减多拍');
  assert.ok(CHIME_ATTACK_S > ATTACK_S, '起音比 sine/piano 软');
  assert.ok(CHIME_DECAY_S > 0.45, '余韵比 piano 长');
  assert.ok(CHIME_LEAD_S < CHIME_ATTACK_S * 2, '引导音是短促音（≤ 2 倍起音时长）');
});

test('音频引擎：未知音色 id 兜底默认合成器，绝不抛错', async () => {
  const { createEngine, DEFAULTS } = (await loaded).internals;
  const { context, nodes } = fakeAudio();
  const engine = createEngine({
    AudioContext: function Fake() { return context; },
    volume: () => 1,
    // 绕过 state 白名单直喂引擎：注册表外的 id（如未来只加了注册项还没挂合成器的音效）。
    voice: () => 'harp',
  });
  assert.equal(engine.play(440), true, '未知 id 仍要出声（兜底默认）');
  assert.equal(nodes.oscillators.length, 1, '兜底 = 默认 sine 合成器：恰 1 个振荡器');
  assert.equal(nodes.oscillators[0].hz, 440);
  assert.equal(DEFAULTS.voice, 'sine');
});

test('清单契约：package.json、patch 与客户端产物', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dsh-rail-tones');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.exports['.'], './index.js');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.ok(Array.isArray(manifest.dsh.client.inject));
  assert.equal(manifest.dependencies, undefined, '插件必须零运行时依赖');

  for (const file of ['index.js', 'client.js', 'cordis.patch.yml']) {
    assert.ok(existsSync(join(root, file)), `${file} 必须存在`);
  }

  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /insert:/);
  assert.match(patch, /id: dsh-rail-tones/);
  assert.match(patch, /name: dsh-rail-tones/);

  const host = readFileSync(join(root, 'index.js'), 'utf8');
  assert.match(host, /export function apply/);
  assert.match(host, /export const inject = \['webServer'\]/);
  assert.match(host, /\/rail-tones\/status/);
  assert.match(host, /\/rail-tones\/report/);

  const source = readFileSync(clientPath, 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(/);
  assert.match(source, /id: 'dsh-rail-tones'/);
  // 客户端必须用文档相对形式上报（页面的 baseURI 是 dsh-app://app/）。
  assert.match(source, /view\.fetch\('rail-tones\/report'/);
  // 设置卡片右下角显示的是 client.js 里的 VERSION，与 package.json 不一致就没法据此判断下发了哪一版。
  const version = source.match(/const VERSION = '([^']+)'/);
  assert.ok(version !== null, 'client.js 必须声明 VERSION');
  assert.equal(version[1], manifest.version);
});

test('设置注册：locale 服务未就绪（undefined）不打断注册链', async () => {
  const { registerSettingsSection, createState, createController } = (await moduleWith(reactRequire)).__internals;
  // 回归：ctx.get('locale') 返回 undefined 时，旧代码的 `locale !== null` 挡不住，
  // 下一句读 locale.register 抛 TypeError，设置卡片在这场启动里永久丢失。
  const ctx = fakeCtx({ locale: undefined });
  const events = [];
  let status = null;
  assert.doesNotThrow(() => {
    status = registerSettingsSection(ctx, {
      state: createState(null),
      controller: createController({}),
      onChange: (why) => events.push(why),
    });
  });
  assert.equal(status.slots, true);
  assert.equal(status.react, true);
  assert.equal(status.registered, true);
  assert.equal(status.error, null);
  assert.deepEqual(events, ['settings-registered']);
  ctx.dispose();
});

test('设置注册：locale 就绪时绑定词典；ctx.get 缺失也不抛', async () => {
  const { registerSettingsSection, createState, createController } = (await moduleWith(reactRequire)).__internals;
  const registered = [];
  const bound = [];
  const locale = {
    register: (id, dictionaries) => registered.push([id, Object.keys(dictionaries)]),
    bind: (id) => {
      bound.push(id);
      return (key) => `en:${key}`;
    },
  };
  const ctx = fakeCtx({ locale });
  const status = registerSettingsSection(ctx, {
    state: createState(null),
    controller: createController({}),
    onChange: () => {},
  });
  assert.equal(status.registered, true);
  assert.deepEqual(registered, [['rail-tones', ['zh', 'en']]]);
  assert.deepEqual(bound, ['rail-tones']);
  ctx.dispose();

  const bare = fakeCtx({ locale: undefined });
  bare.get = () => undefined; // 连 ctx.get 都没有：仍然要走内置中文兜底
  const bareStatus = registerSettingsSection(bare, {
    state: createState(null),
    controller: createController({}),
    onChange: () => {},
  });
  assert.equal(bareStatus.registered, true);
  bare.dispose();
});

test('设置注册：槽位注册被拒时 status.error 保留原文（不被 inject 清空）', async () => {
  const { registerSettingsSection, createState, createController } = (await moduleWith(reactRequire)).__internals;
  const ctx = fakeCtx({
    locale: undefined,
    register: () => {
      throw new Error('slot "settings.section" is not declared');
    },
  });
  const events = [];
  const status = registerSettingsSection(ctx, {
    state: createState(null),
    controller: createController({}),
    onChange: (why) => events.push(why),
  });
  // slots.inject 是同步回调：它成功后不能再把 onOwnerDeclared → tryRegister 记下的失败原文清掉，
  // 否则「槽位在但注册被拒」这一类故障在自报里就只剩 registered:false，无从定位。
  assert.equal(status.injected, true);
  assert.equal(status.registered, false);
  assert.match(status.error, /is not declared/);
  assert.equal(status.retriesLeft, 12, '注册失败应排下有界重试');
  assert.deepEqual(events, []);
  ctx.dispose();
});

test('监听层：明确手势（按下 / 键盘激活）把 repeat 透传给调度器', async () => {
  const rail = makeRail();
  const { listeners, calls } = await startRail(rail);
  const tick = rail.ticks[2];

  rail.dispatch('pointermove', { target: tick, clientY: 25 });
  assert.equal(calls.length, 1, '划过应发声一次');
  assert.equal(calls[0].source, 'hover');
  assert.equal(calls[0].options, undefined, '划过不带 repeat');

  // 回归：适配器曾经丢掉第 4 个参数，于是「点击同一刻度给确认音」在 250ms 窗口内被静音。
  rail.dispatch('pointerdown', { target: tick, clientY: 25 });
  assert.equal(calls.length, 2, '按下即使同音级也要再响一次');
  assert.equal(calls[1].source, 'slide');
  assert.deepEqual(calls[1].options, { repeat: true });

  rail.dispatch('click', { target: tick, clientY: 25, detail: 0 });
  assert.equal(calls.length, 3, '键盘激活同样带确认音');
  assert.equal(calls[2].source, 'click');
  assert.deepEqual(calls[2].options, { repeat: true });

  rail.dispatch('click', { target: tick, clientY: 25, detail: 1 });
  assert.equal(calls.length, 3, '指针点击已在 pointerdown 发声，不再重复');

  listeners.dispose();
});

test('监听层：拖拽中不会被待决的「离开导轨」倒计时清掉锚点', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const rail = makeRail();
  const { listeners } = await startRail(rail);

  rail.dispatch('pointerdown', { target: rail.ticks[1], clientY: 15 });
  // 拖拽中 pointerout 蹭到导轨外的预览气泡 → 排下 300ms 延迟确认
  rail.dispatch('pointerout', { target: rail.ticks[1], relatedTarget: rail.outside });
  assert.equal(listeners.stats().offRailPending, true);

  // 拖拽分支不走 hit()，必须自己取消倒计时，否则锚点会在拖拽中途被清、同音级重放
  rail.dispatch('pointermove', { target: rail.ticks[2], clientY: 25 });
  assert.equal(listeners.stats().offRailPending, false);

  t.mock.timers.tick(400);
  assert.equal(listeners.stats().resets, 0);
  listeners.dispose();
});

test('监听层：真离开导轨满 300ms 才清锚点，回到导轨立即作废', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const rail = makeRail();
  const { listeners, calls } = await startRail(rail);

  rail.dispatch('pointermove', { target: rail.ticks[1], clientY: 15 });
  assert.equal(calls.length, 1);

  // 瞬时异常（宿主重渲染 / 蹭预览气泡）：target 落到导轨之外
  rail.dispatch('pointermove', { target: rail.outside, clientY: 15 });
  assert.equal(listeners.stats().offRailPending, true);
  t.mock.timers.tick(120);
  rail.dispatch('pointermove', { target: rail.ticks[1], clientY: 15 });
  assert.equal(listeners.stats().offRailPending, false, '回到导轨应取消倒计时');
  assert.equal(listeners.stats().resets, 0);
  assert.equal(calls.length, 1, '同一音级不重放');

  // 真离开：倒计时走完，锚点清空
  rail.dispatch('pointermove', { target: rail.outside, clientY: 15 });
  t.mock.timers.tick(400);
  assert.equal(listeners.stats().resets, 1);
  assert.equal(listeners.stats().lastReset.reason, 'move-off-rail');

  // 清空后再划回同一刻度 → 重新发声一次
  rail.dispatch('pointermove', { target: rail.ticks[1], clientY: 15 });
  assert.equal(calls.length, 2);
  listeners.dispose();
});

test('接线：悬停后 100ms 内按下同一刻度仍有确认音（repeat 没被适配器丢掉）', async (t) => {
  const boot = await bootPlugin();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const tick = boot.rail.ticks[2];

  boot.rail.dispatch('pointermove', { target: tick, clientY: 25 });
  assert.equal(boot.debug().status().notesPlayed, 1, '划过应发声一次');

  // 已过 70ms 最小间隔，但仍在 250ms 同音级窗口内：只有 repeat 透传成功才会响。
  t.mock.timers.tick(100);
  boot.rail.dispatch('pointerdown', { target: tick, clientY: 25 });
  assert.equal(boot.debug().status().notesPlayed, 2, '按下是明确手势，应给出确认音');
  assert.equal(boot.debug().log(1)[0].source, 'slide');

  boot.shutdown();
});

test('接线：同一刻度上抖动只响一声（监听层音级闸门真的生效）', async (t) => {
  const boot = await bootPlugin();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const tick = boot.rail.ticks[2];

  boot.rail.dispatch('pointermove', { target: tick, clientY: 25 });
  assert.equal(boot.debug().status().notesPlayed, 1);
  // 越过控制器的 250ms 同音级窗口：此后还拦得住的只有监听层的音级闸门。
  // 回归：适配器曾经吞掉 controller.signal 的返回值，监听层锚点永远不更新，
  // 于是每过 250ms 抖动一下就重响一声（2026-10-06 真实会话日志的原样）。
  t.mock.timers.tick(300);
  boot.rail.dispatch('pointermove', { target: tick, clientY: 25 });
  t.mock.timers.tick(300);
  boot.rail.dispatch('pointermove', { target: tick, clientY: 26 });
  t.mock.timers.tick(300);
  boot.rail.dispatch('pointermove', { target: tick, clientY: 24 });

  assert.equal(boot.debug().status().notesPlayed, 1, '同音级抖动不应再发声');
  const dedup = boot.debug().status().dedup;
  assert.equal(dedup.accepted, 1);
  assert.equal(dedup.skippedByDegree, 3);
  assert.equal(dedup.resets, 0);
  boot.shutdown();
});

test('接线：注册链抛错也会重试，服务就绪后卡片补注册上', async (t) => {
  // 必须在 boot 之前冻结定时器：重试的 setTimeout 是 boot 期间排下的。
  t.mock.timers.enable({ apis: ['setTimeout'], now: 0 });
  const boot = await bootPlugin({ breakSlots: true });
  assert.equal(boot.registered.length, 0, '第一次尝试应当失败');
  assert.deepEqual(
    boot.reports.map((r) => r.reason),
    ['settings-threw', 'mount'],
  );
  assert.match(boot.reports.at(-1).settingsFailure, /slots exploded/);
  assert.equal(boot.reports.at(-1).settings, null);

  boot.heal();
  t.mock.timers.tick(400); // 一次重试间隔
  assert.equal(boot.registered.length, 1, '服务就绪后应把卡片补注册上');
  assert.equal(boot.registered[0].id, 'rail-tones');
  assert.equal(boot.reports.at(-1).reason, 'settings-registered');
  assert.equal(boot.debug().status().settings.registered, true);
  assert.equal(boot.debug().status().settings.slots, true);

  boot.shutdown();
});
