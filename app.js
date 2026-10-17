import { decryptBundle, fromBase64, toBase64, unlockKey } from './crypto.js?v=mvc4rdba';
import { startPuzzle } from './match3.js?v=mvc4rdba';
import { startMemory } from './memory.js?v=mvc4rdba';
import { startSlide } from './slide.js?v=mvc4rdba';
import { initSound, music, sfx } from './sound.js?v=mvc4rdba';

const STORAGE_KEY = 'gift.v1';
const app = document.getElementById('app');
const loadedAt = Date.now();

let config;
let content;
let state;
let bundlePromise;
let timer;

const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const html = (text) => String(text).replace(/[&<>"']/g, (c) => escapes[c]);

// --- Clock and progress -----------------------------------------------------

function now() {
  // A dev build can start the clock at a fixed time to test the unlock moment.
  return config.now ? new Date(config.now).getTime() + (Date.now() - loadedAt) : Date.now();
}

function unlockAt() {
  // "2026-10-18T12:00:00" without an offset is local device time.
  return new Date(config.unlockAt).getTime();
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or full storage: the game still works, it just will not resume.
  }
}

function go(step, patch = {}) {
  Object.assign(state, patch, { step });
  save();
  render();
  window.scrollTo(0, 0);
}

// --- Content ----------------------------------------------------------------

function loadBundle() {
  bundlePromise ??= fetch('bundle.bin', { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error(`bundle.bin: ${response.status}`);
      return response.arrayBuffer();
    })
    .then((buffer) => new Uint8Array(buffer));
  return bundlePromise;
}

async function openContent(rawKey) {
  const bytes = await decryptBundle(config.header, await loadBundle(), rawKey);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function findPerson(id) {
  return id === 'narrator'
    ? { id, ...content.narrator }
    : content.suspects.find((suspect) => suspect.id === id);
}

// --- Rendering helpers ------------------------------------------------------

function avatar(person, size = '') {
  return person.photo
    ? `<img class="avatar ${size}" src="${person.photo}" alt="">`
    : `<div class="avatar ${size}" aria-hidden="true">${person.emoji}</div>`;
}

function photo(item) {
  return item.photo
    ? `<img class="photo" src="${item.photo}" alt="">`
    : '<div class="photo placeholder">Здесь будет фото</div>';
}

// One piece of the sheriff uniform per night, in this order.
const UNIFORM = [
  { id: 'hat', name: 'шляпу' },
  { id: 'star', name: 'звезду шерифа' },
  { id: 'magnifier', name: 'лупу' },
];

const HAT_SVG = `<svg viewBox="0 0 120 60" aria-hidden="true"><path d="M8 44c14 10 90 10 104 0-6 10-26 14-52 14S14 54 8 44z" fill="#8a5a2b"/><path d="M34 44c0-22 6-38 26-38s26 16 26 38c-14 4-38 4-52 0z" fill="#a8713a"/><path d="M34 38c16 4 36 4 52 0v6c-16 4-36 4-52 0z" fill="#5a3818"/></svg>`;

function sheriffPortrait(pieces, size = '') {
  const has = (id) => UNIFORM.slice(0, pieces).some((piece) => piece.id === id);
  return `
    <div class="sheriff ${size}">
      ${avatar(content.player, 'portrait')}
      ${has('hat') ? `<div class="piece hat">${HAT_SVG}</div>` : ''}
      ${has('star') ? '<div class="piece star-badge">★</div>' : ''}
      ${has('magnifier') ? '<div class="piece magnifier">🔍</div>' : ''}
    </div>`;
}

function devTools() {
  return config?.dev ? '<button class="dev-reset" data-dev-reset>Сброс</button>' : '';
}

function screen(theme, body) {
  app.className = `theme-${theme}`;
  app.innerHTML = `<section class="screen">${body}</section>${devTools()}`;
  music.scene(theme);
  for (const button of app.querySelectorAll('[data-next]')) button.addEventListener('click', () => sfx.click());
  app.querySelector('[data-dev-reset]')?.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
}

function on(selector, handler) {
  for (const element of app.querySelectorAll(selector)) {
    element.addEventListener('click', () => handler(element));
  }
}

function formatLeft(ms) {
  const total = Math.ceil(ms / 1000);
  const days = Math.floor(total / 86400);
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(Math.floor((total % 86400) / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return days > 0 ? `${days} д ${time}` : time;
}

// --- Screens ----------------------------------------------------------------

function renderLock() {
  const when = new Date(unlockAt());
  const date = when.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const time = when.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  screen('night', `
    <div class="center grow">
      <div class="moon" aria-hidden="true">🌙</div>
      <h1>Город засыпает…</h1>
      <p class="muted">Игра начнётся ${date} в ${time}</p>
      <div class="countdown" id="countdown"></div>
    </div>`);
  const tick = () => {
    const left = unlockAt() - now();
    if (left <= 0) {
      sfx.unlock();
      render();
      return;
    }
    if (left <= 10000) sfx.tick();
    document.getElementById('countdown').textContent = formatLeft(left);
  };
  tick();
  timer = setInterval(tick, 1000);
}

function renderOath(error = '') {
  const attempts = state.attempts ?? 0;
  screen('dawn', `
    <div class="center">
      <div class="sun" aria-hidden="true">☀️</div>
      <h1>Город просыпается</h1>
      <p>Подарок именинницы пропал. Чтобы начать расследование, шериф даёт клятву.</p>
    </div>
    <form class="card oath" id="oath">
      <label for="answer">${html(config.oath.question)}</label>
      <input id="answer" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
      <button type="submit">Клянусь</button>
      <p class="error" role="alert">${html(error)}</p>
      ${attempts >= 3 ? `<p class="hint">${html(config.oath.hint)}</p>` : ''}
    </form>`);
  loadBundle().catch(() => {}); // Start the download while she types.
  const form = document.getElementById('oath');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const answer = form.answer.value;
    if (!answer.trim()) return;
    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Проверяю…';
    try {
      const rawKey = await unlockKey(config.header, answer);
      if (!rawKey) {
        state.attempts = attempts + 1;
        save();
        sfx.oathWrong();
        renderOath('Клятва не принята. Попробуй ещё раз.');
        return;
      }
      content = await openContent(rawKey);
      sfx.oathOk();
      go(state.step ?? 'role', { key: toBase64(rawKey) }); // After a rebuild, continue where she stopped.
    } catch (error) {
      renderError(error.message);
    }
  });
}

function renderRole() {
  screen('night', `
    <div class="center grow">
      <p class="eyebrow">Твоя роль</p>
      <div class="role-card">
        ${sheriffPortrait(0)}
        <h1>Шериф</h1>
      </div>
      <ul class="rules">
        <li>Три ночи. Каждую ночь ты проверяешь одного подозреваемого и ищешь улику.</li>
        <li>Днём город голосует: кто украл подарок?</li>
        <li>Найди мафию — и подарок вернётся к тебе.</li>
      </ul>
    </div>
    <button data-next>Начать</button>`);
  on('[data-next]', () => go('night', { night: 0, checked: [], uniform: 0 }));
}

// Every name in the lineup takes two lines: first word, then the rest.
function nickLines(nickname) {
  const [first, ...rest] = nickname.split(' ');
  return `${html(first)}<br>${html(rest.join(' ')) || '&nbsp;'}`;
}

function renderNight() {
  const checked = state.checked ?? [];
  const cards = content.suspects.map((suspect) => {
    const done = checked.includes(suspect.id);
    return `
      <button class="suspect ${done ? 'checked' : ''}" data-id="${suspect.id}" ${done ? 'disabled' : ''}>
        ${avatar(suspect)}
        <span class="nick">${nickLines(suspect.nickname)}</span>
        ${done ? '<span class="stamp small">мирный</span>' : ''}
      </button>`;
  }).join('');
  // The ninth seat is the narrator, hidden in the dark: it cannot be checked.
  const secret = `
      <button class="suspect secret" data-secret>
        <div class="avatar" aria-hidden="true">?</div>
        <span class="nick">Тайный<br>игрок</span>
      </button>`;
  screen('night', `
    <p class="eyebrow">Ночь ${state.night + 1} из ${content.nights.length}</p>
    <h1>Шериф просыпается</h1>
    <p class="muted" id="night-hint">Кого проверить этой ночью?</p>
    <div class="grid">${cards}${secret}</div>
    ${albumLink()}`);
  bindAlbumLink();
  on('[data-secret]', () => {
    document.getElementById('night-hint').textContent = 'Слишком темно: лица не разглядеть. Выбери другого.';
  });
  on('.suspect[data-id]', (button) => go('check', { current: button.dataset.id, checked: [...checked, button.dataset.id] }));
}

function renderCheck() {
  const suspect = findPerson(state.current);
  screen('night', `
    <p class="eyebrow">Ночь ${state.night + 1} <span>проверка</span></p>
    <div class="card reveal">
      ${avatar(suspect, 'large')}
      <h2>${html(suspect.nickname)}</h2>
      <p class="muted">${html(suspect.name)}</p>
      <p class="quote">${html(suspect.reaction)}</p>
      <div class="stamp">Мирный житель</div>
    </div>
    <button data-next>Искать улику</button>`);
  sfx.stamp(0.3); // The stamp animation starts after the same delay.
  on('[data-next]', () => go('puzzle'));
}

// Each night plays its own mini-game. Every game reports progress 0..1 and calls onDone once.
const GAMES = {
  match3: {
    help: 'Меняй соседние фишки местами: собери три в ряд.',
    start: (root, { puzzle }, events) => startPuzzle(root, { tiles: content.tiles, goals: puzzle.goals, ...events }),
  },
  memory: {
    help: 'Переворачивай карточки по две и найди пары.',
    start: (root, { puzzle }, events) => startMemory(root, {
      faces: content.suspects.filter((person) => person.photo)
        .map((person) => ({ id: person.id, photo: person.photo, name: person.nickname })),
      pairs: puzzle.pairs ?? 8,
      ...events,
    }),
  },
  slide: {
    help: 'Двигай куски в пустую клетку и собери снимок.',
    start: (root, { clue, puzzle }, events) => startSlide(root, { photo: clue.photo, size: puzzle.size ?? 3, ...events }),
  },
};

function renderPuzzle() {
  const night = state.night;
  const { clue, puzzle } = content.nights[night];
  const piece = UNIFORM[night];
  const game = GAMES[puzzle.type ?? 'match3'];
  screen('night', `
    <p class="eyebrow">Ночь ${night + 1} <span>шериф ищет улики</span></p>
    <div class="develop ${puzzle.type === 'slide' ? 'hidden' : ''}" id="develop">${photo(clue)}</div>
    <div class="puzzle puzzle-${puzzle.type ?? 'match3'}" id="puzzle"></div>
    <p class="muted puzzle-help">${game.help}</p>
    ${config?.dev ? '<button class="dev-reset dev-skip" data-dev-skip>Выиграть</button>' : ''}`);
  const develop = document.getElementById('develop');
  let won = false;
  // A dev build can skip the round: same ending as a real win.
  app.querySelector('[data-dev-skip]')?.addEventListener('click', () => {
    develop.style.setProperty('--developed', 1);
    win();
  });
  game.start(document.getElementById('puzzle'), { clue, puzzle }, {
    onProgress: (done) => develop.style.setProperty('--developed', done),
    onDone: () => win(),
  });

  function win() {
    if (won) return;
    won = true;
    state.uniform = Math.max(state.uniform ?? 0, night + 1);
    save();
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="card dialog award" role="dialog" aria-modal="true">
        <p class="eyebrow">Улика найдена</p>
        ${sheriffPortrait(state.uniform)}
        <h2>Шериф получает ${html(piece.name)}</h2>
        ${foundPhotos(night)}
        <button data-next>Посмотреть улику</button>
      </div>`;
    setTimeout(() => {
      if (!develop.isConnected) return;
      sfx.award();
      app.append(overlay);
      overlay.querySelector('[data-next]').addEventListener('click', () => go('clue'));
    }, 700);
  }
}

// Album photos that a night's win adds to the case file.
function albumFor(night) {
  return (content.album?.items ?? []).filter((item) => item.night === night);
}

function foundPhotos(night) {
  const found = albumFor(night);
  if (!found.length) return '';
  return `
    <p class="found">Шериф взломала телефон мафии: +${found.length} фото</p>
    <div class="found-strip">${found.slice(0, 3).map((item) => `<img src="${item.photo}" alt="">`).join('')}</div>`;
}

function albumItems() {
  return (content.album?.items ?? []).filter((item) => item.night < (state.uniform ?? 0));
}

// A link to the album from any screen once the first photos are found; back returns here.
function albumLink(primary = false) {
  const count = albumItems().length;
  if (!count) return '';
  return `<button ${primary ? '' : 'class="link"'} data-album>${html(content.album.title)} · ${count} фото</button>`;
}

function bindAlbumLink() {
  on('[data-album]', () => go('album', { albumFrom: state.step }));
}

function renderClue() {
  const { clue } = content.nights[state.night];
  const last = state.night === content.nights.length - 1;
  screen('night', `
    <p class="eyebrow">Ночь ${state.night + 1} <span>находка</span></p>
    <div class="card clue">
      ${photo(clue)}
      <h2>${html(clue.title)}</h2>
      <p>${html(clue.text)}</p>
    </div>
    ${albumFor(state.night).length
    ? '<button data-study>Изучить телефон мафии</button>'
    : `<button data-next>${last ? 'Наступает день' : 'Следующая ночь'}</button>`}`);
  sfx.clue();
  on('[data-study]', () => go('album', { albumFrom: 'clue' }));
  on('[data-next]', () => (last ? go('day', { wrong: [] }) : go('night', { night: state.night + 1 })));
}

function renderDay() {
  const wrong = state.wrong ?? [];
  const options = [...content.suspects, { id: 'narrator', ...content.narrator }];
  // The narrator hides like at night; the first tap unmasks him, the second one votes.
  const unmasked = (person) => `
        ${avatar(person, 'small')}
        <span class="vote-name"><b>Любимый муж</b><small>${html(person.name)}, ведущий</small></span>
        <span class="box" aria-hidden="true"></span>`;
  const list = options.map((person) => {
    const out = wrong.includes(person.id);
    if (person.id === 'narrator') {
      return state.unmasked
        ? `<button class="vote" data-id="narrator">${unmasked(person)}</button>`
        : `
      <button class="vote secret" data-id="narrator" data-hidden>
        <div class="avatar small" aria-hidden="true">?</div>
        <span class="vote-name"><b>Тайный игрок</b><small>лица не разглядеть</small></span>
        <span class="box" aria-hidden="true"></span>
      </button>`;
    }
    return `
      <button class="vote ${out ? 'out' : ''}" data-id="${person.id}" ${out ? 'disabled' : ''}>
        ${avatar(person, 'small')}
        <span class="vote-name"><b>${html(person.nickname)}</b><small>${html(person.name)}</small></span>
        <span class="box" aria-hidden="true"></span>
      </button>`;
  }).join('');
  screen('day', `
    <div class="day-head">
      ${sheriffPortrait(state.uniform ?? 0, 'small')}
      <div>
        <p class="eyebrow">День</p>
        <h1>Город голосует</h1>
      </div>
    </div>
    <p>Улики собраны. Кто украл подарок?</p>
    <div class="vote-list">${list}</div>`);
  on('.vote', (button) => {
    const id = button.dataset.id;
    if (button.hasAttribute('data-hidden')) {
      button.removeAttribute('data-hidden');
      button.classList.remove('secret');
      button.innerHTML = unmasked(options.find((person) => person.id === 'narrator'));
      state.unmasked = true;
      save();
      sfx.stamp();
      return;
    }
    sfx.ballot();
    if (id === 'narrator') go('confession');
    else go('alibi', { current: id, wrong: [...wrong, id] });
  });
}

function renderAlibi() {
  const suspect = findPerson(state.current);
  screen('day', `
    <p class="eyebrow">Город не согласен</p>
    <div class="card reveal">
      ${avatar(suspect, 'large')}
      <h2>${html(suspect.nickname)}</h2>
      <p class="label">Алиби</p>
      <p class="quote">${html(suspect.alibi)}</p>
    </div>
    <button data-next>Голосовать снова</button>`);
  sfx.stamp(0.25);
  on('[data-next]', () => go('day'));
}

function renderConfession() {
  const { confession, narrator } = content;
  screen('night', `
    <div class="center grow">
      <p class="eyebrow">Город просыпается и видит…</p>
      ${avatar(narrator, 'large')}
      <h1>${html(confession.title)}</h1>
      ${confession.paragraphs.map((text) => `<p>${html(text)}</p>`).join('')}
    </div>
    <button data-next>${html(confession.button)}</button>`);
  sfx.reveal();
  music.duck(1.2); // After the sting lands.
  on('[data-next]', () => go('letter', { slide: 0 }));
}

function renderLetter() {
  const { letter } = content;
  const lastIndex = letter.slides.length - 1;
  const slides = letter.slides.map((slide, index) => `
    <article class="slide">
      ${photo(slide)}
      <p class="label">${html(slide.label)}</p>
      <p>${html(slide.text)}</p>
      ${index === lastIndex ? `<button data-next>${html(letter.button)}</button>` : ''}
    </article>`).join('');
  const dots = letter.slides.map((_, index) => `<span class="dot" data-dot="${index}"></span>`).join('');
  screen('letter', `
    <h1>${html(letter.title)}</h1>
    <div class="slides" id="slides">${slides}</div>
    <div class="dots" aria-hidden="true">${dots}</div>
    <p class="muted swipe-hint">Листай вбок</p>`);

  const track = document.getElementById('slides');
  // One slide plus the gap: the track has side padding, so its width is not the step.
  const step = () => track.children[1].offsetLeft - track.children[0].offsetLeft;
  const markDot = (index) => {
    for (const dot of app.querySelectorAll('.dot')) dot.classList.toggle('active', Number(dot.dataset.dot) === index);
  };
  const start = Math.min(state.slide ?? 0, lastIndex);
  requestAnimationFrame(() => {
    track.scrollLeft = start * step();
  });
  markDot(start);
  track.addEventListener('scroll', () => {
    const index = Math.round(track.scrollLeft / step());
    if (index === state.slide) return;
    state.slide = index;
    save();
    sfx.page();
    markDot(index);
  }, { passive: true });
  on('[data-next]', () => go('coupons'));
}

function renderCoupons() {
  const used = state.used ?? {};
  const coupons = content.coupons.map((coupon) => {
    const usedAt = used[coupon.id];
    const date = usedAt && new Date(usedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    return `
      <button class="coupon ${usedAt ? 'used' : ''}" data-id="${coupon.id}" ${usedAt ? 'disabled' : ''}>
        <span class="stub" aria-hidden="true">${usedAt ? 'погашен' : 'купон'}</span>
        ${coupon.paid ? '<span class="badge">уже оплачено</span>' : ''}
        <h2>${html(coupon.title)}</h2>
        <p>${html(coupon.text)}</p>
        ${usedAt ? `<span class="stamp">Погашен ${date}</span>` : ''}
      </button>`;
  }).join('');
  screen('letter', `
    <p class="eyebrow">Твой подарок</p>
    <h1>Чековая книжка</h1>
    <p class="muted">Нажми на купон, когда захочешь его использовать, и покажи экран Роме.</p>
    ${albumLink(true)}
    <div class="coupons">${coupons}</div>
    <button class="link" data-letter>Перечитать письмо</button>
    <button class="link" data-replay>Сыграть ещё раз</button>`);
  on('[data-replay]', confirmReplay);
  bindAlbumLink();
  on('.coupon', (button) => confirmCoupon(content.coupons.find((coupon) => coupon.id === button.dataset.id)));
  on('[data-letter]', () => go('letter', { slide: 0 }));
}

// A new round of the story: the oath stays solved, coupons and seen photos stay as they are.
function confirmReplay() {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="card dialog" role="dialog" aria-modal="true">
      <h2>Сыграть ещё раз?</h2>
      <p>Город снова уснёт. Погашенные купоны и просмотренные фото останутся.</p>
      <button data-yes>Начать заново</button>
      <button class="link" data-no>Не сейчас</button>
    </div>`;
  app.append(overlay);
  overlay.querySelector('[data-no]').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-yes]').addEventListener('click', () => {
    go('role', { night: 0, checked: [], uniform: 0, wrong: [], unmasked: false, current: null, albumFrom: null });
  });
}

function confirmCoupon(coupon) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="card dialog" role="dialog" aria-modal="true">
      <h2>Использовать «${html(coupon.title)}»?</h2>
      <p>Купон будет погашен. Покажи этот экран Роме.</p>
      <button data-yes>Использовать</button>
      <button class="link" data-no>Не сейчас</button>
    </div>`;
  app.append(overlay);
  overlay.querySelector('[data-no]').addEventListener('click', () => overlay.remove());
  overlay.querySelector('[data-yes]').addEventListener('click', () => {
    sfx.tear();
    go('coupons', { used: { ...state.used, [coupon.id]: new Date(now()).toISOString() } });
  });
}

// The mafia's phone: every night's win opens part of its gallery. Unseen photos come first.
function renderAlbum() {
  const all = content.album.items;
  const viewed = new Set(state.viewed ?? []);
  const from = state.albumFrom && state.albumFrom !== 'album' ? state.albumFrom : 'coupons';
  const inStory = from === 'clue';
  const unlocked = all.map((item, i) => ({ ...item, i })).filter((item) => item.night < (state.uniform ?? 0));
  const fresh = unlocked.filter((item) => !viewed.has(item.i));
  const ordered = [...fresh, ...unlocked.filter((item) => viewed.has(item.i))];
  const tiles = ordered.map((item) => `
      <button class="phone-tile ${viewed.has(item.i) ? 'seen' : 'new'}" data-i="${item.i}">
        <img src="${item.photo}" alt="">
        ${viewed.has(item.i) ? '<span class="seen-mark" aria-label="просмотрено">✓</span>' : ''}
      </button>`).join('')
    + '<div class="phone-tile locked" aria-hidden="true">🔒</div>'.repeat(all.length - unlocked.length);
  // In the story the night goes on only after tonight's new photos have been looked at.
  const left = fresh.filter((item) => item.night === state.night).length;
  const last = state.night === content.nights.length - 1;
  const action = inStory
    ? (left
      ? `<button disabled>Осталось посмотреть: ${left}</button>`
      : `<button data-next>${last ? 'Наступает день' : 'Следующая ночь'}</button>`)
    : `<button class="link" data-back>${from === 'coupons' ? 'К чековой книжке' : 'Назад'}</button>`;
  screen('night', `
    <p class="eyebrow">${html(content.album.title)} <span>доступ ${unlocked.length} из ${all.length}</span></p>
    <h1>Галерея</h1>
    <p class="muted">${fresh.length ? `Новых фото: ${fresh.length}. Интересно, кто их снимал?` : 'Всё просмотрено. Так кто же их снимал?'}</p>
    <div class="phone-grid">${tiles}</div>
    ${action}`);
  on('.phone-tile[data-i]', (button) => openPhoto(ordered, ordered.findIndex((item) => item.i === Number(button.dataset.i))));
  on('[data-back]', () => go(from));
  on('[data-next]', () => (last ? go('day', { wrong: [] }) : go('night', { night: state.night + 1 })));
}

function openPhoto(list, index) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const show = (k) => {
    const item = list[k];
    state.viewed = [...new Set([...(state.viewed ?? []), item.i])];
    save();
    sfx.photo();
    overlay.innerHTML = `
      <div class="card dialog album-view" role="dialog" aria-modal="true">
        <img src="${item.photo}" alt="">
        <p class="eyebrow">Фото ${item.i + 1} из ${content.album.items.length}</p>
        <p>${html(item.caption)}</p>
        ${k + 1 < list.length ? '<button data-more>Следующее фото</button>' : ''}
        <button class="link" data-close>Закрыть</button>
      </div>`;
    overlay.querySelector('[data-more]')?.addEventListener('click', () => show(k + 1));
  };
  app.append(overlay);
  show(index);
  overlay.addEventListener('click', (event) => {
    if (event.target !== overlay && !event.target.closest('[data-close]')) return;
    overlay.remove();
    renderAlbum();
  });
}

function renderError(message) {
  screen('night', `
    <div class="center grow">
      <h1>Что-то сломалось</h1>
      <p>Позови Рому — он починит.</p>
      <p class="muted small-print">${html(message)}</p>
    </div>`);
}

// --- Flow -------------------------------------------------------------------

const screens = {
  role: renderRole,
  night: renderNight,
  check: renderCheck,
  puzzle: renderPuzzle,
  clue: renderClue,
  day: renderDay,
  alibi: renderAlibi,
  confession: renderConfession,
  letter: renderLetter,
  coupons: renderCoupons,
  album: renderAlbum,
};

function render() {
  clearInterval(timer);
  if (now() < unlockAt()) return renderLock();
  if (!content) return renderOath();
  // A stale step (for example after the content changed) falls back to the start.
  const valid = screens[state.step] && (state.night ?? 0) < content.nights.length
    && (!['check', 'alibi'].includes(state.step) || findPerson(state.current));
  return valid ? screens[state.step]() : go('role');
}

async function start() {
  if (!window.crypto?.subtle) {
    renderError('Браузер не дал доступ к шифрованию. Открой ссылку в Safari по https.');
    return;
  }
  const response = await fetch('config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`config.json: ${response.status}`);
  config = await response.json();
  state = loadState();
  initSound();
  music.start(); // Audible from the first tap: iOS allows audio only inside a gesture.
  if (state.key) {
    try {
      content = await openContent(fromBase64(state.key));
    } catch {
      // The bundle was rebuilt with a new key: ask for the oath again.
      delete state.key;
      save();
    }
  }
  render();
}

start().catch((error) => renderError(error.message));
