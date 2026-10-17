// Sound for the case file: a quiet noir loop under the game and short effects for every
// action, all synthesised with the Web Audio API. No files, no dependencies.
// Roman tunes by ear: every level, the tempo and the key live in TUNING.

export const TUNING = {
  bpm: 74,
  swing: 0.64,          // offbeat eighths land at this fraction of a beat (0.5 = straight)
  root: 45,             // MIDI A2: the key is A minor; bass walks around here, keys an octave up
  bars: 8,              // loop length; the chord sheet below has one entry per bar
  // Bus levels in dBFS. The music sits far below the effects.
  master: -3,
  music: -20,           // measured average lands near -26 dBFS with the peaks below
  sfx: -12,
  duck: 0.45,           // music gain multiplier under the letter, coupons, album, confession
  day: 1.12,            // music gain multiplier on day screens
  lowpass: { night: 3000, day: 3800, soft: 1500 },
  reverb: { seconds: 1.6, wet: 0.3 },
  // Instrument peaks (linear), per note.
  bass: 0.9,
  brush: 0.28,
  hat: 0.1,
  keys: 0.4,
  // Last-10-seconds clock tick and the generic button click: the two most frequent effects.
  tick: 0.35,
  click: 0.25,
};

// Chord sheet: [semitones above the root, quality]. Am | Dm | Am | Am | Dm | Dm | Am | E7.
const CHORDS = [[0, 'm'], [5, 'm'], [0, 'm'], [0, 'm'], [5, 'm'], [5, 'm'], [0, 'm'], [7, '7']];
// Sparse motif: [bar, eighth, MIDI note, decay seconds]. Bar 3 is a rest.
const MOTIF = [
  [0, 0, 76, 1.2], [0, 3, 72, 0.9], [0, 6, 71, 1.4],
  [1, 1, 69, 1.2], [1, 4, 65, 1.6],
  [2, 0, 69, 2.2],
  [4, 0, 74, 1.2], [4, 3, 72, 0.9], [4, 6, 69, 1.4],
  [5, 2, 67, 1.2], [5, 5, 64, 1.8],
  [6, 0, 76, 1.2], [6, 4, 72, 1.6],
  [7, 0, 71, 1.0], [7, 3, 68, 0.9], [7, 6, 64, 1.6],
];
const PENTATONIC = [0, 3, 5, 7, 10]; // minor pentatonic: every effect lives on it
const STORAGE_KEY = 'gift.sound';
const LOOKAHEAD_S = 0.2;
const TIMER_MS = 40;

const dB = (value) => 10 ** (value / 20);
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const beatSec = () => 60 / TUNING.bpm;

let ctx;
let master;
let musicBus;
let musicFilter;
let sfxBus;
let reverbSend;
let noiseBuffer;
let muted = false;
let wanted = false;     // music.start() was called
let ducked = false;
let scene = 'night';
let timer = 0;
let step = 0;
let loopStart = 0;
let toggle;

// --- Graph ------------------------------------------------------------------

function ensure() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  // iOS plays Web Audio as "ambient" by default, which the silent switch mutes.
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
  try {
    ctx = new Ctor({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(ctx.destination);
  master = ctx.createGain();
  master.gain.value = muted ? 0 : dB(TUNING.master);
  master.connect(limiter);

  const reverb = ctx.createConvolver();
  reverb.buffer = impulse();
  reverb.connect(master);
  reverbSend = ctx.createGain();
  reverbSend.gain.value = TUNING.reverb.wet;
  reverbSend.connect(reverb);

  musicFilter = ctx.createBiquadFilter();
  musicFilter.type = 'lowpass';
  musicFilter.frequency.value = TUNING.lowpass[scene] ?? TUNING.lowpass.night;
  musicFilter.Q.value = 0.5;
  musicFilter.connect(master);
  musicFilter.connect(reverbSend);
  musicBus = ctx.createGain();
  musicBus.gain.value = musicLevel();
  musicBus.connect(musicFilter);

  sfxBus = ctx.createGain();
  sfxBus.gain.value = dB(TUNING.sfx);
  sfxBus.connect(master);
  sfxBus.connect(reverbSend);

  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLoop();
    else wake();
  });
  return ctx;
}

function impulse() {
  const length = Math.floor(ctx.sampleRate * TUNING.reverb.seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
    }
  }
  return buffer;
}

function ready() {
  return Boolean(ctx) && !muted && ctx.state === 'running';
}

// --- Voices -----------------------------------------------------------------

function envelope(at, peak, attack, length, decay) {
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(peak, at + attack);
  const end = at + attack + length;
  env.gain.setValueAtTime(peak, end);
  env.gain.setTargetAtTime(0, end, decay / 4);
  return { env, stopAt: end + decay + 0.1 };
}

function tone(at, freq, { type = 'sine', peak = 0.3, attack = 0.005, length = 0, decay = 0.3, glide, lp, bus = sfxBus } = {}) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (glide) osc.frequency.exponentialRampToValueAtTime(glide, at + attack + length + decay * 0.5);
  const { env, stopAt } = envelope(at, peak, attack, length, decay);
  osc.connect(env);
  let out = env;
  if (lp) {
    out = ctx.createBiquadFilter();
    out.type = 'lowpass';
    out.frequency.value = lp;
    env.connect(out);
  }
  out.connect(bus);
  osc.start(at);
  osc.stop(stopAt);
}

function hiss(at, { peak = 0.3, attack = 0.003, length = 0, decay = 0.1, band, q = 1, sweep, lp, hp, bus = sfxBus } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const { env, stopAt } = envelope(at, peak, attack, length, decay);
  let node = src;
  const filters = [band && ['bandpass', band, q], lp && ['lowpass', lp, 0.7], hp && ['highpass', hp, 0.7]].filter(Boolean);
  for (const [type, freq, quality] of filters) {
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, at);
    if (type === 'bandpass' && sweep) filter.frequency.exponentialRampToValueAtTime(sweep, at + attack + length + decay);
    filter.Q.value = quality;
    node.connect(filter);
    node = filter;
  }
  node.connect(env);
  env.connect(bus);
  src.start(at);
  src.stop(stopAt);
}

// Muted vibraphone / Rhodes: a sine with a quiet octave and a short "tine" partial.
function keys(at, midi, { peak = TUNING.keys, decay = 1.2, bus = sfxBus } = {}) {
  const freq = hz(midi);
  tone(at, freq, { peak, attack: 0.008, decay, bus });
  tone(at, freq * 2, { peak: peak * 0.18, attack: 0.008, decay: decay * 0.5, bus });
  tone(at, freq * 3.98, { peak: peak * 0.06, attack: 0.004, decay: decay * 0.2, bus });
}

function bass(at, midi) {
  const freq = hz(midi);
  const length = beatSec() * 0.55;
  tone(at, freq, { type: 'triangle', peak: TUNING.bass, attack: 0.012, length, decay: 0.35, lp: 650, bus: musicBus });
  tone(at, freq, { peak: TUNING.bass * 0.5, attack: 0.012, length, decay: 0.3, bus: musicBus });
}

// --- Music: lookahead scheduler ---------------------------------------------

function walk(bar, beat) {
  const [offset, quality] = CHORDS[bar % CHORDS.length];
  const [nextOffset] = CHORDS[(bar + 1) % CHORDS.length];
  const root = TUNING.root + offset;
  const line = [root, root + (quality === '7' ? 4 : 3), root + 7, TUNING.root + nextOffset + (bar % 2 ? 1 : -1)];
  let note = line[beat];
  while (note > TUNING.root + 10) note -= 12;
  while (note < TUNING.root - 2) note += 12;
  return note;
}

function stepTime(index) {
  const bar = Math.floor(index / 8);
  const eighth = index % 8;
  const offset = eighth % 2 ? TUNING.swing : 0;
  return loopStart + (bar * 4 + Math.floor(eighth / 2) + offset) * beatSec();
}

function playStep(index, at) {
  const bar = Math.floor(index / 8);
  const eighth = index % 8;
  const beat = Math.floor(eighth / 2);
  if (eighth % 2 === 0) bass(at, walk(bar, beat));
  if (eighth === 2 || eighth === 6) {
    hiss(at, { peak: TUNING.brush, attack: 0.02, length: 0.05, decay: 0.14, band: 2000, q: 0.6, lp: 4500, bus: musicBus });
  }
  hiss(at, { peak: TUNING.hat * (eighth % 2 ? 0.6 : 1), attack: 0.002, decay: 0.035, band: 3800, q: 1.4, bus: musicBus });
  for (const [b, e, midi, decay] of MOTIF) {
    if (b === bar && e === eighth) keys(at, midi, { decay, bus: musicBus });
  }
}

function schedule() {
  const steps = TUNING.bars * 8;
  while (stepTime(step) < ctx.currentTime + LOOKAHEAD_S) {
    const at = stepTime(step);
    if (at >= ctx.currentTime) playStep(step, at);
    step += 1;
    if (step >= steps) {
      step = 0;
      loopStart += TUNING.bars * 4 * beatSec();
    }
  }
}

function startLoop() {
  if (timer || !wanted || !ready()) return;
  loopStart = ctx.currentTime + 0.05;
  step = 0;
  schedule();
  timer = setInterval(schedule, TIMER_MS);
}

function stopLoop() {
  clearInterval(timer);
  timer = 0;
}

function musicLevel() {
  return dB(TUNING.music) * (ducked ? TUNING.duck : 1) * (scene === 'day' ? TUNING.day : 1);
}

function applyMusic(delay = 0) {
  if (!ctx) return;
  const at = ctx.currentTime + delay;
  musicBus.gain.setTargetAtTime(musicLevel(), at, 0.4);
  const cutoff = ducked ? TUNING.lowpass.soft : (TUNING.lowpass[scene] ?? TUNING.lowpass.night);
  musicFilter.frequency.setTargetAtTime(cutoff, at, 0.5);
}

export const music = {
  start() {
    wanted = true;
    startLoop();
  },
  duck(delay = 0) {
    ducked = true;
    applyMusic(delay);
  },
  unduck(delay = 0) {
    ducked = false;
    applyMusic(delay);
  },
  // Called for every screen: the letter pages duck, day screens brighten.
  scene(name) {
    scene = name;
    ducked = name === 'letter';
    applyMusic();
  },
};

// --- Unlock on the first gesture (iOS) and the mute toggle ------------------

function wake() {
  if (muted) return;
  const audio = ensure();
  if (!audio) return;
  if (audio.state === 'running') {
    startLoop();
    return;
  }
  audio.resume().then(startLoop).catch(() => {});
}

export function setMuted(value) {
  muted = Boolean(value);
  try {
    localStorage.setItem(STORAGE_KEY, muted ? 'off' : 'on');
  } catch {
    // Storage may be unavailable: the choice then lasts for this visit only.
  }
  if (toggle) {
    toggle.textContent = muted ? 'звук выкл' : 'звук вкл';
    toggle.setAttribute('aria-pressed', String(!muted));
    toggle.classList.toggle('off', muted);
  }
  if (!ctx) return;
  if (muted) {
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    stopLoop();
    setTimeout(() => {
      if (muted) ctx.suspend().catch(() => {});
    }, 300);
  } else {
    master.gain.setTargetAtTime(dB(TUNING.master), ctx.currentTime, 0.05);
    wake();
  }
}

export function initSound() {
  try {
    muted = localStorage.getItem(STORAGE_KEY) === 'off';
  } catch {
    muted = false;
  }
  toggle = document.createElement('button');
  toggle.className = 'sound-toggle';
  toggle.type = 'button';
  toggle.addEventListener('click', () => setMuted(!muted));
  document.body.append(toggle);
  setMuted(muted);
  for (const type of ['pointerup', 'touchend', 'click', 'keydown']) {
    window.addEventListener(type, wake, { capture: true, passive: true });
  }
}

// --- Effects ----------------------------------------------------------------

const pent = (degree, octave = 0) => TUNING.root + 24 + octave * 12 + PENTATONIC[degree % 5] + Math.floor(degree / 5) * 12;

function play(delay, body) {
  if (!ready()) return;
  body(ctx.currentTime + delay);
}

// Noise bursts, thumps and short notes in A minor. Each takes an optional delay in seconds.
export const sfx = {
  click(delay = 0) {
    play(delay, (at) => tone(at, hz(pent(4, 1)), { peak: TUNING.click, attack: 0.002, decay: 0.05 }));
  },
  swap(delay = 0) {
    play(delay, (at) => hiss(at, { peak: 0.25, attack: 0.02, length: 0.03, decay: 0.08, band: 1200, sweep: 2400, q: 1.2 }));
  },
  invalid(delay = 0) {
    play(delay, (at) => {
      tone(at, hz(pent(0, -1)), { type: 'triangle', peak: 0.5, attack: 0.01, decay: 0.18, glide: hz(pent(0, -1)) * 0.8, lp: 500 });
      tone(at + 0.12, hz(pent(0, -1)), { type: 'triangle', peak: 0.4, attack: 0.01, decay: 0.16, glide: hz(pent(0, -1)) * 0.8, lp: 500 });
    });
  },
  // One cascade step: each one plays a degree higher on the pentatonic.
  match(cascade = 0, delay = 0) {
    play(delay, (at) => {
      keys(at, pent(cascade, 1), { peak: 0.55, decay: 0.5 });
      hiss(at, { peak: 0.18, attack: 0.002, decay: 0.05, band: 2600, q: 1 });
    });
  },
  goalTick(delay = 0) {
    play(delay, (at) => tone(at + 0.08, hz(pent(2, 2)), { peak: 0.2, attack: 0.002, decay: 0.07 }));
  },
  goalDone(delay = 0) {
    play(delay, (at) => {
      keys(at + 0.1, pent(2, 1), { peak: 0.5, decay: 0.6 });
      keys(at + 0.22, pent(4, 1), { peak: 0.5, decay: 0.9 });
    });
  },
  shuffle(delay = 0) {
    play(delay, (at) => {
      hiss(at, { peak: 0.3, attack: 0.05, length: 0.2, decay: 0.15, band: 900, sweep: 2200, q: 0.8 });
      [4, 3, 2, 1, 0, 1, 2, 3, 4].forEach((degree, i) => keys(at + 0.04 * i, pent(degree, 1), { peak: 0.3, decay: 0.3 }));
    });
  },
  won(delay = 0) {
    play(delay, (at) => {
      [0, 1, 3, 5].forEach((degree, i) => keys(at + 0.11 * i, pent(degree, 1), { peak: 0.55, decay: 1.2 + i * 0.3 }));
      keys(at + 0.44, pent(0, 0), { peak: 0.4, decay: 2 });
    });
  },
  tick(delay = 0) {
    play(delay, (at) => tone(at, 1100, { peak: TUNING.tick, attack: 0.001, decay: 0.03, lp: 2000 }));
  },
  unlock(delay = 0) {
    play(delay, (at) => {
      keys(at, pent(3, 1), { peak: 0.55, decay: 2 });
      keys(at + 0.35, pent(5, 1), { peak: 0.55, decay: 3 });
      keys(at + 0.35, pent(0, 0), { peak: 0.3, decay: 3 });
    });
  },
  oathOk(delay = 0) {
    play(delay, (at) => {
      tone(at, 70, { peak: 0.9, attack: 0.005, decay: 0.25, glide: 45 });
      hiss(at, { peak: 0.5, attack: 0.002, decay: 0.06, lp: 500 });
      keys(at + 0.18, pent(0, 2), { peak: 0.5, decay: 1.6 });
      keys(at + 0.18, pent(2, 1), { peak: 0.3, decay: 1.6 });
    });
  },
  oathWrong(delay = 0) {
    play(delay, (at) => {
      tone(at, 110, { type: 'triangle', peak: 0.7, attack: 0.005, decay: 0.2, glide: 75, lp: 300 });
      hiss(at, { peak: 0.3, attack: 0.002, decay: 0.05, lp: 400 });
    });
  },
  stamp(delay = 0) {
    play(delay, (at) => {
      hiss(at, { peak: 0.7, attack: 0.002, decay: 0.07, lp: 450 });
      tone(at, 160, { peak: 0.8, attack: 0.003, decay: 0.12, glide: 60 });
      hiss(at + 0.03, { peak: 0.15, attack: 0.01, decay: 0.1, band: 1800, q: 0.8 });
    });
  },
  award(delay = 0) {
    play(delay, (at) => {
      [0, 2, 4, 5, 7].forEach((degree, i) => keys(at + 0.09 * i, pent(degree, 1), { peak: 0.5, decay: 0.8 + i * 0.3 }));
      keys(at + 0.45, pent(0, 0), { peak: 0.35, decay: 2.5 });
      hiss(at + 0.45, { peak: 0.12, attack: 0.1, length: 0.3, decay: 0.6, band: 5000, q: 0.5 });
    });
  },
  clue(delay = 0) {
    play(delay, (at) => {
      hiss(at, { peak: 0.3, attack: 0.04, length: 0.1, decay: 0.2, band: 2400, sweep: 1400, q: 0.7 });
      keys(at + 0.25, pent(3, 1), { peak: 0.35, decay: 1.4 });
    });
  },
  ballot(delay = 0) {
    play(delay, (at) => {
      hiss(at, { peak: 0.35, attack: 0.005, length: 0.04, decay: 0.05, band: 3200, sweep: 1800, q: 0.9 });
      hiss(at + 0.09, { peak: 0.3, attack: 0.005, length: 0.03, decay: 0.05, band: 2400, sweep: 3600, q: 0.9 });
    });
  },
  reveal(delay = 0) {
    play(delay, (at) => {
      tone(at, hz(pent(0, -1)), { type: 'sawtooth', peak: 0.3, attack: 0.9, length: 0.3, decay: 0.8, lp: 700 });
      tone(at, hz(pent(3, -1)), { type: 'sawtooth', peak: 0.22, attack: 0.9, length: 0.3, decay: 0.8, lp: 700 });
      keys(at + 1.0, pent(0, 2), { peak: 0.5, decay: 2.5 });
      keys(at + 1.0, pent(2, 1), { peak: 0.3, decay: 2.5 });
    });
  },
  page(delay = 0) {
    play(delay, (at) => hiss(at, { peak: 0.18, attack: 0.03, length: 0.04, decay: 0.1, band: 1500, sweep: 900, q: 0.8 }));
  },
  tear(delay = 0) {
    play(delay, (at) => {
      hiss(at, { peak: 0.5, attack: 0.01, length: 0.18, decay: 0.08, band: 700, sweep: 3200, q: 2.5 });
      hiss(at, { peak: 0.25, attack: 0.01, length: 0.18, decay: 0.08, band: 1800, q: 0.6 });
    });
  },
  photo(delay = 0) {
    play(delay, (at) => {
      hiss(at, { peak: 0.25, attack: 0.01, length: 0.02, decay: 0.06, band: 2000, sweep: 1200, q: 0.8 });
      keys(at + 0.05, pent(1, 1), { peak: 0.3, decay: 0.9 });
    });
  },
  // Memory: a card turns, a pair stamps, a miss turns back.
  flip(delay = 0) {
    play(delay, (at) => hiss(at, { peak: 0.22, attack: 0.01, length: 0.03, decay: 0.07, band: 1400, sweep: 2600, q: 1 }));
  },
  pair(delay = 0) {
    play(delay, (at) => {
      hiss(at, { peak: 0.45, attack: 0.002, decay: 0.06, lp: 500 });
      keys(at + 0.06, pent(2, 1), { peak: 0.45, decay: 0.7 });
      keys(at + 0.18, pent(4, 1), { peak: 0.45, decay: 1.0 });
    });
  },
  miss(delay = 0) {
    play(delay, (at) => {
      tone(at, hz(pent(1, -1)), { type: 'triangle', peak: 0.3, attack: 0.01, decay: 0.16, glide: hz(pent(1, -1)) * 0.85, lp: 600 });
      hiss(at + 0.1, { peak: 0.15, attack: 0.01, length: 0.03, decay: 0.07, band: 1200, sweep: 700, q: 1 });
    });
  },
  // Sliding puzzle: a piece slides, the photo peeks out, the last piece drops in.
  slide(delay = 0) {
    play(delay, (at) => {
      hiss(at, { peak: 0.28, attack: 0.01, length: 0.08, decay: 0.08, band: 800, sweep: 1500, q: 0.9 });
      tone(at + 0.12, 180, { peak: 0.25, attack: 0.002, decay: 0.05, glide: 120, lp: 600 });
    });
  },
  peek(delay = 0) {
    play(delay, (at) => {
      hiss(at, { peak: 0.2, attack: 0.04, length: 0.1, decay: 0.2, band: 2400, sweep: 1600, q: 0.7 });
      keys(at + 0.1, pent(3, 1), { peak: 0.25, decay: 0.8 });
    });
  },
  solved(delay = 0) {
    play(delay, (at) => {
      hiss(at, { peak: 0.5, attack: 0.002, decay: 0.07, lp: 500 });
      tone(at, 150, { peak: 0.6, attack: 0.003, decay: 0.12, glide: 60 });
      [0, 2, 4].forEach((degree, i) => keys(at + 0.2 + 0.1 * i, pent(degree, 1), { peak: 0.45, decay: 1.0 + i * 0.3 }));
    });
  },
};
