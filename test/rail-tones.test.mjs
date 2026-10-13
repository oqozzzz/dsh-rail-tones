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
  assert.ok(Array.isArray(VOICE_OPTIONS) && VOICE_OPTIONS.length >= 4, '注册表至少含 sine / piano / chime / mimo');
  assert.deepEqual(ids, ['sine', 'piano', 'chime', 'mimo'], '注册表顺序即设置列表顺序');
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
  const nodes = { oscillators: [], gains: [], filters: [] };
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
        // v0.2.6：刮弦音首分音带失谐（mimo 原文 I.detune.value=1.5）。
        detune: { setValueAtTime: (value) => { osc.detuned = value; } },
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
    // v0.2.6：刮弦音的 lowpass 滤波器（4200→1400Hz 扫频）。
    createBiquadFilter() {
      const node = { type: '', frequencyValues: [] };
      node.frequency = {
        setValueAtTime: (value) => { node.frequencyValues.push(value); },
        exponentialRampToValueAtTime: (value) => { node.frequencyValues.push(value); },
      };
      node.connect = () => {};
      node.disconnect = () => {};
      nodes.filters.push(node);
      return node;
    },
  };
  return { context, nodes };
}

test('音频引擎：上下文 suspended 时丢弃调度而非堆叠在冻结的 currentTime 上', async () => {
  const { createEngine } = (await loaded).internals;
  const { context, nodes } = fakeAudio();
  context.state = 'suspended';
  const engine = createEngine({
    AudioContext: function Fake() { return context; },
    volume: () => 1,
    voice: () => 'sine',
  });
  // 回归：suspended 时 currentTime 冻结，旧代码照常调度 → 整段时间窗的音符
  // 堆在同一时间戳，resume 瞬间齐鸣。现在必须丢弃（不建任何节点）并返回 false。
  assert.equal(engine.play(440), false, 'suspended 时 play 必须返回 false');
  assert.equal(nodes.oscillators.length, 0, 'suspended 时不得创建振荡器');
  // resume 后恢复正常发声。
  context.state = 'running';
  assert.equal(engine.play(440), true);
  assert.equal(nodes.oscillators.length, 1);
});

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

/** mimo 复刻音色的用例群：音高映射、滑动速度门槛、包络、以及接线。 */

test('mimo 音高映射：逐字移植原文 s(d,m) —— 刻度下标 / 刻度总数', async () => {
  const { mimoFrequencyAt, MIMO_NOTES, MIMO_STEPS } = (await loaded).internals;
  assert.deepEqual([...MIMO_NOTES], [261.63, 293.66, 329.63, 392, 440], 'C4 D4 E4 G4 A4');
  assert.equal(MIMO_STEPS, 18, 'r.length × 3.6 = 18');

  // 原文：C = round(d / max(1, m-1) × 18)，d = 刻度下标、m = 刻度总数。
  // 5 个刻度时逐档摊开整个 18 档阶梯（这是「移植」与 v0.2.4「复刻」的关键差别：
  // v0.2.4 误把 0…1 的位置当刻度下标、又把本项目音级数 10 当总数，
  // 结果整条音阶被压进最低 3 个半音，0.5 处只有 146.83Hz）。
  assert.ok(Math.abs(mimoFrequencyAt(0, 5) - 130.815) < 0.01, '刻度 0/4 = C3');
  assert.ok(Math.abs(mimoFrequencyAt(1, 5) - 261.63) < 0.01, '刻度 1/4 = C4');
  assert.ok(Math.abs(mimoFrequencyAt(2, 5) - 440) < 0.01, '刻度 2/4 = A4');
  assert.ok(Math.abs(mimoFrequencyAt(3, 5) - 880) < 0.01, '刻度 3/4 = A5');
  assert.ok(Math.abs(mimoFrequencyAt(4, 5) - 1568) < 0.01, '刻度 4/4 = G6');
  // 18 个刻度：round(17/17×18)=18 → 顶档 G6（1568Hz）。
  assert.ok(Math.abs(mimoFrequencyAt(17, 18) - 1568) < 0.01, '18 刻度时顶档 = step 18 = G6');
  assert.ok(Math.abs(mimoFrequencyAt(8, 18) - 392) < 0.01, '18 刻度中点 = step 8 = G4');

  // 单调不减：整条导轨逐刻度扫过不会出现音高回落。
  let previous = 0;
  for (let step = 0; step <= 40; step += 1) {
    const hz = mimoFrequencyAt(step, 41);
    assert.ok(hz >= previous, `刻度 ${step}/40 处音高回落`);
    previous = hz;
  }
  // 非法输入。
  assert.equal(mimoFrequencyAt(Number.NaN, 18), null);
  assert.equal(mimoFrequencyAt(undefined, 18), null);
  assert.equal(mimoFrequencyAt(0, Number.NaN), null);
  assert.equal(mimoFrequencyAt(0, null), null);
  assert.equal(mimoFrequencyAt(0, 0), null);
  // 单刻度（m=1）：原文 Math.max(1, m-1) → 恒为最低档。
  assert.equal(mimoFrequencyAt(0, 1), mimoFrequencyAt(0, 5), '单刻度 = 最低档（原文 max(1,m-1)）');
});

test('mimo 音高兜底：有刻度用刻度，没刻度退化为「铺满导轨」的等价形态', async () => {
  const { mimoHzFor, mimoFrequencyAt, MIMO_STEPS } = (await loaded).internals;
  // 有刻度信息 → 走原文语义（刻度下标 / 刻度总数）。
  assert.equal(mimoHzFor({ tick: 2, tickCount: 5, position: 0.9 }), mimoFrequencyAt(2, 5), '刻度优先于位置');
  assert.equal(mimoHzFor({ tick: 0, tickCount: 5 }), mimoFrequencyAt(0, 5));
  // 没有刻度（试听 / 宿主不提供 data-index）→ position 当作铺满的刻度比例。
  assert.equal(mimoHzFor({ position: 0 }), mimoFrequencyAt(0, MIMO_STEPS), '位置 0 = 最低档');
  assert.equal(mimoHzFor({ position: 1 }), mimoFrequencyAt(MIMO_STEPS - 1, MIMO_STEPS), '位置 1 = 最高档');
  assert.equal(mimoHzFor({ position: 0.5 }), mimoFrequencyAt(Math.round(0.5 * (MIMO_STEPS - 1)), MIMO_STEPS));
  // 非法输入。
  assert.equal(mimoHzFor(null), null);
  assert.equal(mimoHzFor({ position: Number.NaN }), null);
});

test('mimo 滑动速度门槛：逐字移植原文 Le/qe/Ve/fe（慢速放行、快速甩动静音）', async () => {
  const { createMimoGate, MIMO_GATE_ENTRY_MS, MIMO_GATE_WINDOW_MS, MIMO_GATE_MAX_SPEED } = (await loaded).internals;
  assert.equal(MIMO_GATE_ENTRY_MS, 100, '原文 ke');
  assert.equal(MIMO_GATE_WINDOW_MS, 80, '原文 He');
  assert.equal(MIMO_GATE_MAX_SPEED, 600, '原文 je');

  // v0.2.6 起裁决为三态：'mute'（起步窗内，原文静音）/ 'strum'（快速甩动，本项目改播刮弦音）/
  // 'pass'（慢速放行，正常单音）。原文的 false 拆成了前两态。
  const gate = createMimoGate({});
  assert.equal(gate.allow({ x: 0, y: 0 }, 0), 'mute', '进入瞬间静音');
  assert.equal(gate.allow({ x: 0, y: 50 }, 50), 'mute', '仍在 100ms 内');
  assert.equal(gate.allow({ x: 0, y: 56 }, 140), 'pass', '慢速划过放行（100px/s）');
  // 快速甩动 → 'strum'：60ms 内 60px = 1000px/s，且两帧都在 80ms 取样窗口内。
  const fast = createMimoGate({});
  assert.equal(fast.allow({ x: 0, y: 0 }, 0), 'mute');
  assert.equal(fast.allow({ x: 0, y: 50 }, 50), 'mute', '仍在 100ms 内');
  assert.equal(fast.allow({ x: 0, y: 110 }, 110), 'strum', '60ms/60px = 1000px/s > 600 → 刮弦音');
  assert.equal(fast.allow({ x: 0, y: 170 }, 170), 'strum', '持续快速划过 → 继续刮弦音');
  // 临界：恰好 600px/s 判快速（原文严格小于），583px/s 放行。
  const boundary = (px) => {
    const probe = createMimoGate({});
    probe.allow({ x: 0, y: 0 }, 0); // 记 entryAt
    probe.allow({ x: 0, y: 0 }, 100); // 窗口内首帧
    return probe.allow({ x: 0, y: px }, 160); // 60ms 后
  };
  assert.equal(boundary(35), 'pass', '583px/s → 放行');
  assert.equal(boundary(36), 'strum', '恰好 600px/s → 快速（严格 <）');
  assert.equal(boundary(37), 'strum', '617px/s → 快速');

  // 持续慢速划动始终放行。
  const slow = createMimoGate({});
  slow.allow({ x: 0, y: 0 }, 0);
  assert.equal(slow.allow({ x: 0, y: 4 }, 100), 'pass');
  assert.equal(slow.allow({ x: 0, y: 8 }, 160), 'pass');
  const flick = createMimoGate({});
  flick.allow({ x: 0, y: 0 }, 0);
  assert.equal(flick.allow({ x: 0, y: 100 }, 100), 'pass', '窗口内只有一帧 → 原文放行');
  assert.equal(flick.allow({ x: 0, y: 200 }, 160), 'strum', '两帧入窗后 → 1000px/s 快速');

  // 单帧（样本 <2）放行 —— 原文 `samples.length < 2 ⇒ true`。
  const single = createMimoGate({});
  assert.equal(single.allow({ x: 0, y: 0 }, 0), 'mute', '首帧仍受 entry 窗口约束');
  assert.equal(single.allow({ x: 0, y: 0 }, 200), 'pass', '窗口内只剩一帧 → 放行（原文语义）');

  // reset()（离开导轨 / blur，原文 fe）后重新进入 100ms 观察窗。
  const leaving = createMimoGate({});
  leaving.allow({ x: 0, y: 0 }, 0);
  assert.equal(leaving.allow({ x: 0, y: 3 }, 120), 'pass', '复位前慢速放行');
  leaving.reset();
  assert.equal(leaving.allow({ x: 0, y: 6 }, 140), 'mute', '复位后重新进入 100ms 观察窗');
  assert.equal(leaving.stats().samples, 1, 'reset 清空采样');

  // 手势缺失 / 非法坐标一律 'pass'（点击、滚轮、试听不走这条路）。
  assert.equal(gate.allow(null, 0), 'pass');
  assert.equal(gate.allow(undefined, 0), 'pass');
  assert.equal(createMimoGate({}).allow({ x: Number.NaN, y: 0 }, 0), 'pass');
});

test('音频引擎：mimo 音色 = 三角波 + 双档包络，响度对齐其它音色', async () => {
  const {
    createEngine,
    VOICES,
    PEAK_FACTOR,
    MIMO_HOVER_GAIN,
    MIMO_HIT_GAIN,
    MIMO_HOVER_PEAK,
    MIMO_HIT_PEAK,
    MIMO_ATTACK_S,
    MIMO_DECAY_S,
    MIMO_HIT_DECAY_S,
    MIMO_STOP_PAD_S,
  } = (await loaded).internals;
  // 原文绝对增益只作记录（v0.2.7 起不再直接使用）。
  assert.equal(MIMO_HOVER_GAIN, 0.13, '原文 hover 绝对增益（记录值）');
  assert.equal(MIMO_HIT_GAIN, 0.3, '原文 hit 绝对增益（记录值）');
  // 生效峰值：强音档与 sine 等峰、弱音档取其 7 成 —— 对齐其它音色响度。
  assert.equal(MIMO_HIT_PEAK, PEAK_FACTOR, '强音档 = PEAK_FACTOR（与 sine 100% 等峰）');
  assert.equal(MIMO_HOVER_PEAK, 0.6, '弱音档 ≈ 其它音色满音量峰值的 7 成');
  assert.ok(MIMO_HIT_PEAK > MIMO_HOVER_PEAK, '点击强音档仍应响于划过弱音档');
  assert.ok(MIMO_HOVER_PEAK > MIMO_HOVER_GAIN && MIMO_HIT_PEAK > MIMO_HIT_GAIN, '响度对齐 = 两档都抬于原文裸值');
  assert.ok(MIMO_HIT_PEAK < 1 && MIMO_HOVER_PEAK < 1, '两档满音量都在满幅之内（不削波）');

  const build = (volume) => {
    const { context, nodes } = fakeAudio();
    const engine = createEngine({
      AudioContext: function FakeAudioContext() { return context; },
      volume: () => volume,
      voice: () => VOICES.mimo,
    });
    return { engine, context, nodes };
  };

  // hover（划过，原文 `p(s(d,m), !1)`）：三角波、8ms 指数升到弱音档峰值、0.42s 衰减、+0.05s 停振。
  const hover = build(1);
  assert.equal(hover.engine.play(261.63, { source: 'hover', strong: false }), true);
  assert.equal(hover.nodes.oscillators.length, 1, 'mimo 音恰 1 个振荡器');
  assert.equal(hover.nodes.oscillators[0].type, 'triangle', '必须是三角波（3 次谐波 ≈ −19dB 的亮泛音来源）');
  assert.equal(hover.nodes.oscillators[0].hz, 261.63);
  const hoverValues = hover.nodes.gains[0].gain.values;
  assert.deepEqual(hoverValues, [0.0001, MIMO_HOVER_PEAK, 0.0001], '包络：1e-4 → 弱音档峰值 → 1e-4');
  assert.equal(MIMO_ATTACK_S, 0.008, '原文 h+.008');
  assert.equal(MIMO_DECAY_S, 0.42, '原文 hover 衰减');
  assert.ok(
    Math.abs(hover.nodes.oscillators[0].stopAt - (1.5 + MIMO_DECAY_S + MIMO_STOP_PAD_S)) < 1e-9,
    '停振点 = 衰减 + 0.05s（原文 .46）',
  );

  // 强音档（点击刻度 / 键盘激活 / 试听，原文 `p(s(d,m), !0)`）：峰值 PEAK_FACTOR、衰减 0.9s。
  const click = build(1);
  assert.equal(click.engine.play(261.63, { source: 'click', strong: true }), true);
  const clickValues = click.nodes.gains[0].gain.values;
  assert.deepEqual(clickValues, [0.0001, MIMO_HIT_PEAK, 0.0001], '点击 = 强音档 PEAK_FACTOR');
  assert.equal(MIMO_HIT_DECAY_S, 0.9, '原文 hit 衰减');
  assert.ok(
    Math.abs(click.nodes.oscillators[0].stopAt - (1.5 + MIMO_HIT_DECAY_S + MIMO_STOP_PAD_S)) < 1e-9,
    '强音停振 = 0.95s',
  );
  // 强音必须比弱音响。
  assert.ok(clickValues[1] > hoverValues[1], '点击强音应明显响于划过');

  // 没有 strong 标记（如滚轮 / 拖拽）→ 弱音档。
  const plain = build(1);
  plain.engine.play(261.63, { source: 'wheel' });
  assert.ok(Math.abs(plain.nodes.gains[0].gain.values[1] - MIMO_HOVER_PEAK) < 1e-12, '滚轮走弱音档');

  // 音量线性缩放；音量 0 静音。
  const half = build(0.5);
  half.engine.play(261.63, { source: 'hover', strong: false });
  assert.ok(Math.abs(half.nodes.gains[0].gain.values[1] - MIMO_HOVER_PEAK * 0.5) < 1e-12, '峰值随音量线性缩放');
  const zero = build(0);
  assert.equal(zero.engine.play(261.63, { source: 'hover' }), false);
  assert.equal(zero.nodes.oscillators.length, 0, '音量为 0 不建节点');
});

test('音频引擎：存量音色忽略第 4 参 meta（向后兼容）', async () => {
  const { createEngine, VOICES, PEAK_FACTOR } = (await loaded).internals;
  const { context, nodes } = fakeAudio();
  const engine = createEngine({
    AudioContext: function Fake() { return context; },
    volume: () => 1,
    voice: () => VOICES.sine,
  });
  // v0.2.4 起引擎会把 meta 作为第 4 参传给合成器：既有合成器必须完全无视它。
  assert.equal(engine.play(440, { source: 'click', degree: 3, tick: 7 }), true);
  assert.equal(nodes.oscillators.length, 1);
  assert.equal(nodes.oscillators[0].type, 'sine');
  assert.equal(nodes.oscillators[0].hz, 440);
  assert.ok(Math.abs(nodes.gains[0].gain.values[1] - PEAK_FACTOR) < 1e-12, '包络不受 meta 影响');
});

test('调度器：音色自带的音高映射优先（context 形式），缺省回退 noteHz', async () => {
  const { createController, mimoHzFor, noteHz } = (await loaded).internals;
  const played = [];
  let clock = 0;
  let pitch = null;
  const controller = createController({
    play: (hz) => played.push(hz),
    now: () => clock,
    isEnabled: () => true,
    pitchAt: (context) => (pitch === null ? null : pitch(context)),
  });

  // 没有自带映射（如 sine）→ 沿用全局的位置→音级→频率。
  assert.equal(controller.signal(0.5, 'hover'), true);
  assert.equal(played[0], noteHz(5), '缺省映射 = noteHz');
  // 挂上 mimo 的映射 → 按刻度下标/总数算音高。
  pitch = mimoHzFor;
  clock = 500;
  assert.equal(controller.signal(0.5, 'click', 2, { repeat: true }, { hover: false, tick: 2, tickCount: 5 }), true);
  assert.equal(played[1], mimoHzFor({ tick: 2, tickCount: 5 }), '自带映射优先');
  assert.ok(Math.abs(played[1] - 440) < 0.01, '刻度 2/5 = A4');
  // 没有刻度信息时用位置兜底。
  clock = 1000;
  assert.equal(controller.signal(1, 'click', null, { repeat: true }, { hover: false }), true);
  assert.equal(played[2], mimoHzFor({ position: 1 }), '无刻度 → 位置兜底');
  // 映射抛错也要静默回退，不影响发声。
  pitch = () => {
    throw new Error('boom');
  };
  clock = 1500;
  assert.equal(controller.signal(1, 'click', null, { repeat: true }, { hover: false }), true);
  assert.equal(played[3], noteHz(9), '映射抛错回退 noteHz');
});

test('调度器：去重键可注入 —— mimo 按刻度下标，其它音色按音级', async () => {
  const { createController, dedupKeyFor } = (await loaded).internals;
  assert.equal(dedupKeyFor('mimo', 3, 7), 7, 'mimo 用刻度下标');
  assert.equal(dedupKeyFor('mimo', 3, null), 3, '没有刻度时退回音级');
  assert.equal(dedupKeyFor('sine', 3, 7), 3, '其它音色用音级');
  assert.equal(dedupKeyFor('piano', 9, 2), 9);

  const played = [];
  let clock = 0;
  let voice = 'mimo';
  const controller = createController({
    play: (hz, meta) => played.push({ hz, ...meta }),
    now: () => clock,
    isEnabled: () => true,
    keyFor: (degree, tick) => dedupKeyFor(voice, degree, tick),
  });
  // 同一刻度（key=5）在 250ms 窗口内不重响。
  assert.equal(controller.signal(0.5, 'hover', 5), true);
  clock = 100;
  assert.equal(controller.signal(0.5, 'hover', 5), false, '同刻度窗口内不响');
  // 相邻刻度（key=6）即便落在同一 10 档音级里，也应各自发声 —— 这是 mimo 的粒度。
  clock = 120;
  assert.equal(controller.signal(0.52, 'hover', 6), true, '相邻刻度应各自发声（mimo 粒度）');
  assert.equal(played.length, 2);
  // 其它音色：换回音级粒度 —— 相邻刻度若同音级则不响。
  voice = 'sine';
  clock = 400;
  assert.equal(controller.signal(0.5, 'hover', 5), true, '切回音级粒度后可响');
  clock = 500;
  const sameDegreeTicks = [7, 8].filter((t) => dedupKeyFor('sine', 5, t) === 5);
  assert.ok(sameDegreeTicks.length === 2, '前提：这两个刻度在 sine 下同音级');
  assert.equal(controller.signal(0.5, 'hover', 7), false, 'sine：同音级不响');
  assert.equal(controller.signal(0.5, 'hover', 8), false, 'sine：同音级仍不响');
});

test('调度器：meta.strong 只在明确手势（repeat）时为真', async () => {
  const { createController } = (await loaded).internals;
  const played = [];
  let clock = 0;
  const controller = createController({
    play: (hz, meta) => played.push(meta),
    now: () => clock,
    isEnabled: () => true,
  });
  // 划过 / 滚轮 → 弱音档。
  assert.equal(controller.signal(0.2, 'hover'), true);
  assert.equal(played[0].strong, false, '划过 = 弱音档');
  clock = 500;
  assert.equal(controller.signal(0.5, 'wheel'), true);
  assert.equal(played[1].strong, false, '滚轮 = 弱音档');
  // 点击 / 键盘激活 / 试听（repeat）→ 强音档（原文 hit 路径）。
  clock = 1000;
  assert.equal(controller.signal(0.8, 'slide', 9, { repeat: true }), true);
  assert.equal(played[2].strong, true, '按下 = 强音档');
  assert.equal(played[2].tick, 9);
  clock = 1500;
  assert.equal(controller.signal(0.8, 'preview', null, { repeat: true }), true);
  assert.equal(played[3].strong, true, '试听 = 强音档');
});

test('接线：apply 的 pitchAt 按当前音色挑映射（sine 走 noteHz、mimo 走刻度映射）', async () => {
  const { pitchForVoice, resolvePitch, mimoHzFor, noteHz, createController } = (await loaded).internals;

  // 注册表里只有 mimo 自带映射；其它音色必须返回 null（→ 回退 noteHz）。
  assert.equal(pitchForVoice('mimo'), mimoHzFor);
  assert.equal(pitchForVoice('sine'), null);
  assert.equal(pitchForVoice('piano'), null);
  assert.equal(pitchForVoice('chime'), null);
  assert.equal(pitchForVoice('no-such-voice'), null);
  assert.equal(resolvePitch(null, { degree: 5, position: 0.5 }), null, '没有自带映射 → null（回退 noteHz）');

  // 逐字复用 apply 里那一行装配：`resolvePitch(pitchForVoice(state.get().voice), context)`。
  // 回归：这条断言盯的是「音色 → 映射」的选择真的接上了 —— 若把 apply 里那行写成
  // `() => null`（或漏调 pitchForVoice），切到 mimo 后音高仍会是 noteHz，此处立即失败。
  let voice = 'sine';
  let clock = 0;
  const played = [];
  const controller = createController({
    pitchAt: (context) => resolvePitch(pitchForVoice(voice), context),
    play: (hz, meta) => played.push({ hz, ...meta }),
    now: () => clock,
    isEnabled: () => true,
  });

  // sine：位置 0.5 → 本项目的 A 大调五声（noteHz(5) = 440）。
  controller.signal(0.5, 'click', 5, { repeat: true });
  assert.equal(played[0].hz, noteHz(5), '默认音色 = 全局 noteHz');
  assert.equal(played[0].hz, 440);

  // mimo：同一个刻度（下标 2 / 总数 5）→ 刻度映射给出 A4（440Hz）。
  // 换到刻度 3 以避开 250ms 同键窗口（mimo 按刻度去重）。
  voice = 'mimo';
  clock = 500;
  controller.signal(0.5, 'click', 3, { repeat: true }, { hover: false, tick: 3, tickCount: 5 });
  assert.equal(played[1].hz, mimoHzFor({ tick: 3, tickCount: 5 }), 'mimo 音色必须走刻度映射');
  assert.ok(Math.abs(played[1].hz - 880) < 0.01, '刻度 3/5 = A5');
  assert.notEqual(played[1].hz, noteHz(5), '同一位置两套映射给出不同的音');
});

test('接线：走真实 apply，音色切换后 debug().play() 用该音色的映射发声', async (t) => {
  // 上面的用例直接调 resolvePitch；这一条走**完整 apply**，盯的是「apply 里真的调了
  // pitchForVoice(state.get().voice)」——把 apply 里那行写成 `() => null` 时，
  // 上面那条仍会通过，只有这条会失败。
  const boot = await bootPlugin();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const { noteHz, mimoHzFor } = (await loaded).internals;

  // 默认 sine：0.5 处 = A 大调五声第 5 档 = 440Hz。
  boot.debug().play(0.5);
  let log = boot.debug().log(1)[0];
  assert.equal(log.hz, noteHz(5), '默认音色走 noteHz');
  assert.equal(log.hz, 440);

  // 切到 mimo：debug().play() 不带刻度 → 走位置兜底（铺满 18 档的等价形态）。
  boot.debug().setVoice('mimo');
  assert.equal(boot.debug().status().voice, 'mimo');
  t.mock.timers.tick(300); // 越过 70ms 最小间隔
  boot.debug().play(0.5);
  log = boot.debug().log(1)[0];
  assert.equal(
    log.hz,
    mimoHzFor({ position: 0.5 }),
    'mimo 音色必须走自带映射（apply 真的接了 pitchForVoice）',
  );
  assert.notEqual(log.hz, noteHz(5), '同一位置两套映射给出不同的音');

  boot.shutdown();
});

test('调度器：滑动速度门槛只作用于「划过」（gesture.hover），裁决透传 meta', async () => {
  const { createController } = (await loaded).internals;
  const played = [];
  let clock = 0;
  const asked = [];
  const controller = createController({
    play: (hz, meta) => played.push({ hz, ...meta }),
    now: () => clock,
    isEnabled: () => true,
    // v0.2.6 三态裁决桩：y≤100 'mute'、y≥400 'strum'、其余 'pass'。
    gate: (gesture, at) => {
      asked.push({ gesture, at });
      return gesture.y <= 100 ? 'mute' : gesture.y >= 400 ? 'strum' : 'pass';
    },
  });

  // 划过带 hover 标记 → 被门槛拦下时不发声、也不更新去重锚点。
  assert.equal(controller.signal(0.2, 'hover', 1, undefined, { hover: true, x: 0, y: 10 }), false);
  assert.equal(played.length, 0);
  assert.equal(asked.length, 1, '划过才问门槛');
  // 放行后正常发声。
  assert.equal(controller.signal(0.2, 'hover', 1, undefined, { hover: true, x: 0, y: 300 }), true);
  assert.equal(played.length, 1);
  assert.equal(asked.length, 2, '第二次划过又问了一次');
  assert.equal(played[0].gate, 'pass', 'meta 带上裁决');
  // 快速划过 → 裁决 'strum' 也发声（本项目增强：改播刮弦音），meta 原样带出。
  clock = 400;
  assert.equal(controller.signal(0.5, 'hover', 2, undefined, { hover: true, x: 0, y: 400 }), true);
  assert.equal(played[1].gate, 'strum', '快速划过的裁决透传给音色分发');
  // 点击 / 滚轮 / 试听：上下文里 hover=false（或没有上下文）→ 一律不判门槛。
  const askedAfterHover = asked.length;
  clock = 500;
  assert.equal(controller.signal(0.2, 'click', 1, { repeat: true }, { hover: false }), true, '点击不走速度门槛');
  clock = 1000;
  assert.equal(controller.signal(0.2, 'wheel', 1, undefined, { hover: false }), true, '滚轮不走速度门槛');
  clock = 1500;
  assert.equal(controller.signal(0.2, 'preview', null, { repeat: true }), true, '试听没有上下文也不判');
  assert.equal(asked.length, askedAfterHover, '点击 / 滚轮 / 试听都没问门槛');
});

test('接线：监听层把刻度下标/总数与坐标交给调度器，离开导轨时复位门槛', async () => {
  const rail = makeRail();
  const { attachRailListeners, dedupKeyFor } = (await moduleWith(reactRequire)).__internals;
  const calls = [];
  let resets = 0;
  let voice = 'mimo';
  const listeners = attachRailListeners({
    view: rail.view,
    arm() {},
    gate: {
      reset() {
        resets += 1;
      },
    },
    keyFor: (degree, tick) => dedupKeyFor(voice, degree, tick),
    signal: (position, source, tick, options, gesture) => {
      calls.push({ position, source, tick, options, gesture });
      return true;
    },
  });

  // 划过：带坐标 + 刻度下标 + 刻度总数（mimo 的音高与门槛都要用）。
  rail.dispatch('pointermove', { target: rail.ticks[2], clientY: 25, clientX: 7 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, 'hover');
  assert.equal(calls[0].gesture.hover, true, '划过必须带 hover 标记（门槛只作用于它）');
  assert.deepEqual([calls[0].gesture.x, calls[0].gesture.y], [7, 25], '划过带坐标');
  assert.equal(calls[0].tick, 2, '带刻度下标');
  assert.equal(calls[0].gesture.tickCount, rail.ticks.length, '带刻度总数（5）');
  assert.equal(calls[0].gesture.tick, 2);

  // 按下：明确手势（repeat），带刻度信息但 hover=false（不判速度门槛）。
  rail.dispatch('pointerdown', { target: rail.ticks[2], clientY: 25, clientX: 7 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].source, 'slide');
  assert.deepEqual(calls[1].options, { repeat: true });
  assert.equal(calls[1].gesture.hover, false, '按下不受滑动速度门槛约束');
  assert.equal(calls[1].gesture.tickCount, rail.ticks.length, '按下也要刻度总数（算音高）');

  // mimo 粒度：相邻刻度（2 → 3）即便同属一个 10 档音级，也必须各自发声。
  rail.dispatch('pointermove', { target: rail.ticks[3], clientY: 35, clientX: 7 });
  assert.equal(calls.length, 3, 'mimo 音色下相邻刻度应各自发声');
  assert.equal(calls[2].tick, 3);
  // 切到按音级去重的音色后，**同一刻度重复划过**不发声（第二次被闸门跳过）。
  voice = 'sine';
  rail.dispatch('pointermove', { target: rail.ticks[3], clientY: 35, clientX: 7 });
  const afterSwitch = calls.length;
  rail.dispatch('pointermove', { target: rail.ticks[3], clientY: 35, clientX: 7 });
  assert.equal(calls.length, afterSwitch, 'sine：同刻度重复划过不发声');
  const dedup = listeners.stats();
  assert.ok(dedup.skippedByDegree >= 1, '同键被闸门跳过');

  // 「离开导轨」延迟确认到点 → 门槛采样复位（真离开再划回来算一段新手势）。
  // 注意：离开的判定走 pointerout 的 relatedTarget 分支，必须带上导轨外的 relatedTarget。
  const before = resets;
  rail.dispatch('pointerout', { target: rail.ticks[2], relatedTarget: rail.outside });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(resets > before, '离开导轨后应复位门槛采样');
  listeners.dispose();
});

test('接线：走真实 apply，mimo 音色下滑过相邻刻度会各自发声（监听层也用了 keyFor）', async (t) => {
  // 回归：v0.2.4 的监听层闸门按 10 档音级去重，而 mimo 应按刻度下标 ——
  // 只给控制器注入 keyFor 而漏掉监听层时，相邻刻度会在控制器之前就被拦掉。
  // 这条用例走完整 apply，盯的正是「监听层也注入了同一个 keyFor」。
  //
  // 关键：刻度 3 与刻度 4 在本项目的 10 档划分里**同属音级 2**（位置 0.175 / 0.225），
  // 所以「mimo 下从刻度 3 滑到刻度 4 仍能发声」只有在监听层按刻度去重时才成立；
  // 监听层若仍按音级去重，第二帧会被它直接拦掉（notesPlayed 停在 1）。
  const boot = await bootPlugin();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  boot.debug().setVoice('mimo');

  // mimo 首帧被 100ms 观察窗拦下（原文 Ve 语义）。
  boot.rail.dispatch('pointermove', { target: boot.rail.ticks[3], clientY: 35, clientX: 7 });
  assert.equal(boot.debug().status().notesPlayed, 0, 'mimo 首帧静音（100ms 观察窗）');

  // 第二帧起手（刻度 3），此后它就是锚点。
  t.mock.timers.tick(200);
  boot.rail.dispatch('pointermove', { target: boot.rail.ticks[3], clientY: 35, clientX: 7 });
  assert.equal(boot.debug().status().notesPlayed, 1, '第二帧发声（刻度 3）');
  assert.equal(boot.debug().log(1)[0].tick, 3);
  const dedup = boot.debug().status().dedup;
  assert.equal(dedup.accepted, 1, '锚点已写入');
  assert.equal(dedup.skippedByDegree, 0);

  // 滑到刻度 4（**同属 10 档音级 2**）：mimo 下必须再响一声。
  t.mock.timers.tick(200);
  boot.rail.dispatch('pointermove', { target: boot.rail.ticks[4], clientY: 45, clientX: 7 });
  assert.equal(boot.debug().status().notesPlayed, 2, 'mimo：同音级内的相邻刻度也要各自发声');
  const logs = boot.debug().log(2);
  assert.deepEqual(logs.map((l) => l.tick), [3, 4], '刻度 3、4 各响一声');
  // 音高按刻度映射（刻度 4 / 总数 5 → 顶档 1568Hz）。
  const { mimoFrequencyAt } = (await loaded).internals;
  assert.equal(logs[1].hz, Math.round(mimoFrequencyAt(4, 5) * 100) / 100, '末声 = 刻度映射');
  assert.equal(logs[1].hz, 1568, '刻度 4/5 = G6');
  boot.shutdown();
});

test('接线：走真实 apply，划过 / 按下各自发声（明确手势给确认音）', async (t) => {
  const boot = await bootPlugin();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  boot.debug().setVoice('mimo');

  // mimo 的划过第一帧被 100ms 观察窗拦下（原文语义），第二帧才发声。
  boot.rail.dispatch('pointermove', { target: boot.rail.ticks[1], clientY: 15, clientX: 7 });
  assert.equal(boot.debug().status().notesPlayed, 0, 'mimo 首帧静音（100ms 观察窗）');
  t.mock.timers.tick(200);
  boot.rail.dispatch('pointermove', { target: boot.rail.ticks[2], clientY: 25, clientX: 7 });
  assert.equal(boot.debug().status().notesPlayed, 1, '第二帧发声');
  assert.equal(boot.debug().log(1)[0].source, 'hover');
  assert.equal(boot.debug().log(1)[0].tick, 2);

  // 按下 = 明确手势（repeat）→ 不经速度门槛，同一刻度也给确认音。
  t.mock.timers.tick(200);
  boot.rail.dispatch('pointerdown', { target: boot.rail.ticks[2], clientY: 25, clientX: 7 });
  assert.equal(boot.debug().status().notesPlayed, 2, '按下给确认音（不走速度门槛）');
  assert.equal(boot.debug().log(1)[0].source, 'slide');
  boot.shutdown();
});

test('音频引擎：mimo 刮弦音 = 5 分音 × 频率 + lowpass 扫频，峰值按 √len 归一', async () => {
  const {
    createEngine,
    VOICES,
    MIMO_HOVER_PEAK,
    MIMO_HIT_PEAK,
    MIMO_STRUM_BASE_S,
    MIMO_STRUM_MIN_S,
    MIMO_STRUM_MAX_S,
    MIMO_STRUM_ATTACK_S,
    MIMO_STRUM_FILTER_FROM_HZ,
    MIMO_STRUM_FILTER_TO_HZ,
    MIMO_STRUM_FILTER_SPAN,
    MIMO_STRUM_DETUNE_CENTS,
    MIMO_STRUM_PARTIALS,
    MIMO_STOP_PAD_S,
  } = (await loaded).internals;

  const build = (volume) => {
    const { context, nodes } = fakeAudio();
    const engine = createEngine({
      AudioContext: function FakeAudioContext() { return context; },
      volume: () => volume,
      voice: () => VOICES.mimo,
    });
    return { engine, context, nodes };
  };

  // 单频刮弦（快速滑动的本项目增强路径）：5 个分音 + 1 条 master gain + 1 个 lowpass。
  const one = build(1);
  assert.equal(one.engine.play(440, { strum: { freqs: [440], ring: 1.1, strong: false } }), true);
  assert.equal(one.nodes.oscillators.length, MIMO_STRUM_PARTIALS.length, '每频 5 分音');
  assert.equal(one.nodes.gains.length, MIMO_STRUM_PARTIALS.length + 1, '分音 gain + master gain');
  assert.equal(one.nodes.filters.length, 1, 'lowpass 滤波器');
  // 分音矩阵逐字对齐：倍数 / 增益 / 波形。
  const spec = [[1, 1, 'triangle'], [2, 0.42, 'sine'], [3, 0.22, 'sine'], [4, 0.12, 'sine'], [6, 0.06, 'sine']];
  assert.deepEqual(
    MIMO_STRUM_PARTIALS.map((p) => [p[0], p[1], p[2]]),
    spec,
    '原文 J = [[1,1,triangle],[2,.42,sine],[3,.22,sine],[4,.12,sine],[6,.06,sine]]',
  );
  spec.forEach((partial, index) => {
    const osc = one.nodes.oscillators[index];
    assert.equal(osc.type, partial[2], `分音 ${index + 1} 波形`);
    assert.ok(Math.abs(osc.hz - 440 * partial[0]) < 1e-6, `分音 ${index + 1} 频率 = f×${partial[0]}`);
    assert.ok(Math.abs(one.nodes.gains[index + 1].gain.values[0] - partial[1]) < 1e-12, `分音 ${index + 1} 增益`);
  });
  assert.equal(one.nodes.oscillators[0].detuned, MIMO_STRUM_DETUNE_CENTS, '原文首分音 detune=1.5 音分');
  assert.equal(one.nodes.oscillators[1].detuned, undefined, '失谐只作用于首分音（其余从未调用 detune）');
  // 时长 F = clamp(0.25+ring, .4, 2.6)；ring=1.1 → 1.35s。
  const duration = MIMO_STRUM_BASE_S + 1.1;
  const master = one.nodes.gains[0];
  assert.equal(master.gain.values.length, 3, 'master：1e-4 → 峰值 → 1e-4');
  assert.ok(Math.abs(master.gain.values[1] - MIMO_HOVER_PEAK) < 1e-12, '弱音档峰值（单频 √1 不衰减）');
  assert.ok(
    Math.abs(one.nodes.oscillators[0].stopAt - (1.5 + duration + MIMO_STOP_PAD_S)) < 1e-9,
    '停振 = F + 0.05',
  );
  // lowpass：4200 → 1400Hz（0.85F 处）—— 钉住原文字面值，别跟着常量跑。
  assert.equal(one.nodes.filters[0].type, 'lowpass');
  assert.deepEqual(one.nodes.filters[0].frequencyValues, [4200, 1400], '原文 L.frequency 4200→1400');
  assert.equal(MIMO_STRUM_FILTER_FROM_HZ, 4200, '常量钉住原文');
  assert.equal(MIMO_STRUM_FILTER_TO_HZ, 1400, '常量钉住原文');
  assert.ok(MIMO_STRUM_FILTER_SPAN === 0.85, '原文 F*.85');

  // 双频和弦：峰值按 1/√2 归一（不削波）、分音数 ×2。
  const two = build(1);
  two.engine.play(440, { strum: { freqs: [440, 550], ring: 0.4, strong: true } });
  assert.equal(two.nodes.oscillators.length, MIMO_STRUM_PARTIALS.length * 2, '两频 = 10 个振荡器');
  assert.ok(
    Math.abs(two.nodes.gains[0].gain.values[1] - MIMO_HIT_PEAK / Math.SQRT2) < 1e-12,
    '强音档峰值 ÷ √len',
  );

  // clamp 边界：ring 太小 → 0.4s，ring 太大 → 2.6s。
  assert.equal(Math.max(MIMO_STRUM_MIN_S, Math.min(MIMO_STRUM_MAX_S, MIMO_STRUM_BASE_S + 0.05)), MIMO_STRUM_MIN_S);
  assert.equal(Math.max(MIMO_STRUM_MIN_S, Math.min(MIMO_STRUM_MAX_S, MIMO_STRUM_BASE_S + 9)), MIMO_STRUM_MAX_S);

  // 休止（freqs 空）→ 不建任何节点（原文 if(!d.length)return），但返回 true（手势已消耗）。
  const rest = build(1);
  assert.equal(rest.engine.play(440, { strum: { freqs: [], ring: 0.4, strong: false } }), true);
  assert.equal(rest.nodes.oscillators.length, 0, '休止不建节点');
  assert.equal(rest.nodes.filters.length, 0);
});

test('mimo 彩蛋状态机：5% 掷骰 / 180s 冷却 / 手势逐音推进 / 离开复位资格', async () => {
  const { createMimoEgg, MIMO_EGG_SONGS, MIMO_EGG_PROBABILITY, MIMO_EGG_COOLDOWN_MS, MIMO_EGG_LOOPS } =
    (await loaded).internals;
  assert.equal(MIMO_EGG_PROBABILITY, 0.05, '原文 S');
  assert.equal(MIMO_EGG_COOLDOWN_MS, 180 * 1000, '原文 V');
  assert.equal(MIMO_EGG_LOOPS, 1, '原文 U');
  assert.equal(MIMO_EGG_SONGS.length, 5);
  // 曲库完整性核对（与逆向原文逐首一致）。
  assert.deepEqual(
    MIMO_EGG_SONGS.map((s) => [s.bpm, s.notes.length]),
    [[76, 40], [150, 77], [120, 105], [72, 34], [72, 82]],
    '5 首曲子的 bpm 与音数',
  );
  // 致爱丽丝开头：E5 D#5 E5 D#5 E5 B4 D5 C5 A4（唱名只是标签，定音看音名）。
  assert.deepEqual(
    MIMO_EGG_SONGS[0].notes.slice(0, 9).map((n) => Math.round(n.f[0] * 100) / 100),
    [659.26, 622.25, 659.26, 622.25, 659.26, 493.88, 587.33, 523.25, 440],
  );
  // 休止 = 空频率；和弦 = 多频率。
  assert.equal(MIMO_EGG_SONGS[0].notes[9].f.length, 0, '第 10 音是休止');
  assert.equal(MIMO_EGG_SONGS[1].notes.filter((n) => n.f.length > 1).length, 2, '第 2 首有 2 个和弦');

  let clock = 0;
  let roll = 0;
  const build = () =>
    createMimoEgg({
      now: () => clock,
      random: () => roll,
    });

  // 未命中概率 → 不激活；每轮互动只掷一次（k 语义）。
  const off = build();
  roll = 0.99;
  assert.equal(off.attempt({ strong: false, roll: true }), null, '骰子不中就按常规单音走');
  assert.equal(off.stats().rolled, true, '本轮已掷过（k=true）');
  assert.equal(off.attempt({ strong: false, roll: true }), null, '第二轮手势不再掷');
  off.endEngagement();
  assert.equal(off.stats().rolled, false, '离开导轨 → 重新获得掷骰资格');

  // 命中 → 逐音推进：第一次 attempt 就奏出第一个音（原文 X(!1) 立刻播 R[0]）。
  const egg = build();
  roll = 0.04;
  const first = egg.attempt({ strong: false, roll: true });
  assert.ok(first !== null, '5% 命中 → 激活');
  assert.deepEqual(first.freqs, MIMO_EGG_SONGS[0].notes[0].f, '默认骰 0 → 第 1 首');
  assert.equal(first.strong, false, 'hover 推进走弱音');
  const second = egg.attempt({ strong: false, roll: false });
  assert.deepEqual(second.freqs, MIMO_EGG_SONGS[0].notes[1].f, '第二帧推进到第 2 音');
  // 激活期间的 hit → 强音推进（原文 hit: i(R[x].freqs,!0,...)）。
  clock = 500;
  const hitNote = egg.attempt({ strong: true, roll: false });
  assert.deepEqual(hitNote.freqs, MIMO_EGG_SONGS[0].notes[2].f);
  assert.equal(hitNote.strong, true, '彩蛋期间的点击 = 强音推进');
  // 掷骰选曲：rnd=0.04 命中 + 选曲用同一次 Math.random → 第 1 首；换 rnd 组合选到别的曲子。
  const egg2 = createMimoEgg({
    now: () => clock,
    random: (() => {
      let step = 0;
      return () => {
        step += 1;
        return step === 1 ? 0.01 : 0.999; // 命中，但选曲落在最后一首
      };
    })(),
  });
  const pick = egg2.attempt({ strong: false, roll: true });
  assert.deepEqual(
    pick.freqs,
    MIMO_EGG_SONGS[MIMO_EGG_SONGS.length - 1].notes[0].f,
    '选曲用独立的 random() 抽样',
  );

  // 播完整曲：40 个音后自动结束 → 结束时刻记入冷却起点（原文 X 尾部 j=now）。
  const full = build();
  roll = 0.04;
  clock = 0;
  assert.ok(full.attempt({ strong: false, roll: true }) !== null);
  for (let i = 1; i < MIMO_EGG_SONGS[0].notes.length; i += 1) {
    clock = i * 10;
    assert.ok(full.attempt({ strong: false, roll: false }) !== null, `第 ${i + 1} 音还在推进`);
  }
  const endedAt = (MIMO_EGG_SONGS[0].notes.length - 1) * 10;
  clock = endedAt + 10;
  assert.equal(full.attempt({ strong: false, roll: false }), null, '播完自动结束');
  assert.equal(full.stats().active, false);
  assert.equal(full.stats().lastFinishedAt, endedAt, '结束时刻记入冷却起点（原文 X 尾部 j=now）');
  // 冷却未满 → 再掷不中；满 180s → 可再触发。
  roll = 0.0;
  full.endEngagement();
  clock = endedAt + MIMO_EGG_COOLDOWN_MS - 1;
  assert.equal(full.attempt({ strong: false, roll: true }), null, '冷却期内不再开新彩蛋');
  full.endEngagement();
  clock = endedAt + MIMO_EGG_COOLDOWN_MS;
  assert.ok(full.attempt({ strong: false, roll: true }) !== null, '满 180s → 可再次触发');

  // reset（卸载，原文 resetEgg）：打断进行中 → 冷却从打断时刻重算、状态清空。
  const interrupt = build();
  roll = 0.04;
  clock = 500000;
  assert.ok(interrupt.attempt({ strong: false, roll: true }) !== null);
  interrupt.reset();
  assert.equal(interrupt.stats().active, false);
  assert.equal(interrupt.stats().lastFinishedAt, 500000, '打断也推冷却起点');
  assert.equal(interrupt.stats().noteIndex, 0, '音序清零');
});

test('接线：走真实 apply，mimo 下快速滑动播刮弦音', async (t) => {
  // 桩掉随机源：骰子 99% 不中，只验「快速甩动 → 刮弦音」这条确定性路径。
  t.mock.method(Math, 'random', () => 0.99);
  const boot = await bootPlugin();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  boot.debug().setVoice('mimo');

  // 起步 100ms 观察窗（'mute'）→ 静音。
  boot.rail.dispatch('pointermove', { target: boot.rail.ticks[2], clientY: 25, clientX: 7 });
  assert.equal(boot.debug().status().notesPlayed, 0, '首帧静音');

  // 慢速划到相邻刻度 → 'pass'：常规单音（不是刮弦）。
  t.mock.timers.tick(200);
  boot.rail.dispatch('pointermove', { target: boot.rail.ticks[3], clientY: 35, clientX: 7 });
  assert.equal(boot.debug().status().notesPlayed, 1);
  assert.equal(boot.debug().log(1)[0].strum, false, '慢速 = 常规单音');

  // 快速甩动：两次划过间隔 75ms（>70ms 节流、<80ms 取样窗口 → 两帧都在窗口内），
  // 纵跳 80px ≈ 1066px/s ≥ 600 → 裁决 'strum'。mimo 本体此时静音；本项目增强为播刮弦音。
  t.mock.timers.tick(200);
  boot.rail.dispatch('pointermove', { target: boot.rail.ticks[1], clientY: 15, clientX: 7 });
  assert.equal(boot.debug().status().notesPlayed, 2);
  t.mock.timers.tick(75);
  boot.rail.dispatch('pointermove', { target: boot.rail.ticks[4], clientY: 95, clientX: 7 });
  assert.equal(boot.debug().status().notesPlayed, 3, '快速甩动不再静音，而是播刮弦音');
  const fastLog = boot.debug().log(1)[0];
  assert.equal(fastLog.strum, true, '快速划过 → 刮弦音路径');
  assert.equal(fastLog.egg, false, '快速划过不掷骰也不推进彩蛋');

  const stats = boot.debug().status().egg;
  assert.equal(stats.active, false, '骰子 99% 不中：status 暴露彩蛋状态');
  boot.shutdown();
});

test('接线：走真实 apply，彩蛋命中后手势逐音推进刮弦旋律', async (t) => {
  // 桩掉随机源：第一次抽样命中（<0.05）、第二次选曲落第 1 首。
  let draws = 0;
  t.mock.method(Math, 'random', () => {
    draws += 1;
    return draws === 1 ? 0.01 : 0.0;
  });
  const boot = await bootPlugin();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  boot.debug().setVoice('mimo');
  const { MIMO_EGG_SONGS } = (await loaded).internals;

  boot.rail.dispatch('pointermove', { target: boot.rail.ticks[2], clientY: 25, clientX: 7 });
  t.mock.timers.tick(200);
  boot.rail.dispatch('pointermove', { target: boot.rail.ticks[3], clientY: 35, clientX: 7 });
  // 这一帧掷骰命中 → 本帧即播第 1 音（原文触发帧也调 X 播首音）。
  assert.equal(boot.debug().status().notesPlayed, 1);
  assert.equal(boot.debug().log(1)[0].egg, true, '命中帧改播彩蛋音');
  assert.equal(boot.debug().status().egg.active, true);
  assert.equal(boot.debug().status().egg.noteIndex, 1, '已推进 1 音');
  // 激活后每帧推进（log.hz 仍是位置单音的 hz —— 它只是记录，发声走 strum）。
  t.mock.timers.tick(200);
  boot.rail.dispatch('pointermove', { target: boot.rail.ticks[4], clientY: 45, clientX: 7 });
  assert.equal(boot.debug().status().egg.noteIndex, 2, '下一帧推进到第 2 音');
  assert.equal(boot.debug().log(1)[0].egg, true);
  assert.ok(MIMO_EGG_SONGS[0].notes[1].f.length > 0);
  boot.shutdown();
});

test('清单契约：package.json、patch 与客户端产物', async () => {
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

  // 派生断言（运行时结构级，比正则匹配源码更强）：注册表每个条目必须挂着
  // 可调用的合成器，查询器对未知 id 返回 null、对默认音色必须能查到 ——
  // 新音效「注册表加了、合成器忘挂」这种漂移立即在此显形。
  const { VOICE_OPTIONS, DEFAULTS, synthForVoice } = (await loaded).internals;
  assert.equal(typeof synthForVoice, 'function', '必须导出 synthForVoice 查询器');
  for (const option of VOICE_OPTIONS) {
    assert.equal(typeof option.synth, 'function', `注册表条目 "${option.id}" 必须持有合成器`);
    assert.equal(synthForVoice(option.id), option.synth, `synthForVoice("${option.id}") 应命中该条目`);
  }
  assert.equal(synthForVoice('no-such-voice'), null, '未知 id 必须返回 null');
  assert.equal(typeof synthForVoice(DEFAULTS.voice), 'function', '默认音色必须可查到合成器');
  assert.equal(synthForVoice(null), null);
  assert.equal(synthForVoice(undefined), null);
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
