// «Восстанови снимок»: a sliding puzzle. The clue photo is cut into a grid with one piece
// missing; a tap or a swipe slides a piece next to the gap. The board is shuffled with legal
// moves, so it always solves. A "peek" button shows the whole photo, and after three minutes
// a link lets the sheriff finish the board, so the gift never gets stuck.

import { sfx } from './sound.js?v=mvc4rdba';

const SLIDE_MS = 160;
const SHUFFLE_MOVES = 80;
const PEEK_MS = 1500;
const HELP_AFTER_MS = 3 * 60 * 1000;
const WIN_MS = 900;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function startSlide(root, { photo, size, onProgress, onDone }) {
  const n = size ?? 3;
  const count = n * n;
  const last = count - 1;
  // cells[position] = piece index; the piece index is also its solved position. The last
  // piece is the gap: it stays hidden until the board is solved.
  const cells = Array.from({ length: count }, (_, i) => i);
  let busy = false;
  let finished = false;
  let peekTimer;
  let helpTimer;

  root.innerHTML = `
    <div class="slide-board" role="application" aria-label="Разрезанный снимок" style="--size: ${n}">
      ${cells.map((piece) => `
        <div class="slide-piece ${piece === last ? 'gap' : ''}" data-piece="${piece}">
          <div class="slide-cut" style="background-image: url('${photo}'); background-position: ${(piece % n) * (100 / (n - 1))}% ${Math.floor(piece / n) * (100 / (n - 1))}%"></div>
        </div>`).join('')}
      <img class="slide-whole" src="${photo}" alt="" draggable="false">
    </div>
    <div class="slide-tools">
      <button class="slide-peek" type="button">Подсмотреть</button>
      <button class="link slide-help hidden" type="button">Помочь шерифу</button>
    </div>`;
  const board = root.querySelector('.slide-board');
  const pieces = Array.from(board.querySelectorAll('.slide-piece'));
  const peek = root.querySelector('.slide-peek');
  const help = root.querySelector('.slide-help');

  // --- Model ----------------------------------------------------------------

  const gapAt = () => cells.indexOf(last);
  const neighbours = (pos) => {
    const r = Math.floor(pos / n);
    const c = pos % n;
    return [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]
      .filter(([rr, cc]) => rr >= 0 && rr < n && cc >= 0 && cc < n)
      .map(([rr, cc]) => rr * n + cc);
  };
  const isSolved = () => cells.every((piece, pos) => piece === pos);
  const progress = () => cells.filter((piece, pos) => piece !== last && piece === pos).length / last;

  function swapWithGap(pos) {
    const gap = gapAt();
    [cells[pos], cells[gap]] = [cells[gap], cells[pos]];
  }

  function shuffle() {
    let previous = -1;
    let moves = 0;
    while (moves < SHUFFLE_MOVES || isSolved()) {
      const options = neighbours(gapAt()).filter((pos) => pos !== previous);
      const pos = options[Math.floor(Math.random() * options.length)];
      previous = gapAt();
      swapWithGap(pos);
      moves += 1;
    }
  }

  // --- View -----------------------------------------------------------------

  function layout() {
    cells.forEach((piece, pos) => {
      pieces[piece].style.transform = `translate(${(pos % n) * 100}%, ${Math.floor(pos / n) * 100}%)`;
    });
  }

  function positionFromPoint(event) {
    const rect = board.getBoundingClientRect();
    const c = Math.floor(((event.clientX - rect.left) / rect.width) * n);
    const r = Math.floor(((event.clientY - rect.top) / rect.height) * n);
    return r >= 0 && r < n && c >= 0 && c < n ? r * n + c : -1;
  }

  async function win() {
    finished = true;
    busy = true;
    clearTimeout(helpTimer);
    clearTimeout(peekTimer);
    board.classList.remove('peeking');
    pieces[last].classList.remove('gap');
    board.classList.add('solved');
    sfx.solved();
    onProgress?.(1);
    await sleep(WIN_MS);
    if (root.isConnected) onDone?.();
  }

  async function slide(pos) {
    if (!neighbours(gapAt()).includes(pos)) return;
    busy = true;
    sfx.slide();
    swapWithGap(pos);
    layout();
    onProgress?.(progress());
    await sleep(SLIDE_MS);
    if (!root.isConnected) return;
    if (isSolved()) {
      await win();
      return;
    }
    busy = false;
  }

  // --- Input: tap or swipe a piece next to the gap -----------------------------

  let start = null;

  board.addEventListener('pointerdown', (event) => {
    if (busy || finished) return;
    const pos = positionFromPoint(event);
    if (pos === -1 || cells[pos] === last) return;
    start = { pos, x: event.clientX, y: event.clientY, done: false };
    board.setPointerCapture(event.pointerId);
  });

  board.addEventListener('pointermove', (event) => {
    if (!start || start.done || busy) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const threshold = board.clientWidth / n / 4;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return;
    start.done = true;
    slide(start.pos);
  });

  board.addEventListener('pointerup', () => {
    if (start && !start.done && !busy) slide(start.pos);
    start = null;
  });

  board.addEventListener('pointercancel', () => {
    start = null;
  });

  // --- Peek: hold to see the whole photo, a tap shows it for a moment ------------

  let peekSince = 0;

  function showPeek() {
    if (finished) return;
    clearTimeout(peekTimer);
    peekSince = Date.now();
    if (!board.classList.contains('peeking')) sfx.peek();
    board.classList.add('peeking');
  }

  function hidePeek() {
    const left = PEEK_MS - (Date.now() - peekSince);
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => board.classList.remove('peeking'), Math.max(0, left));
  }

  peek.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    showPeek();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) peek.addEventListener(type, hidePeek);
  peek.addEventListener('contextmenu', (event) => event.preventDefault());

  // --- Help: after three minutes the board can be finished with one tap ------------

  helpTimer = setTimeout(() => {
    if (root.isConnected && !finished) help.classList.remove('hidden');
  }, HELP_AFTER_MS);

  help.addEventListener('click', () => {
    if (finished) return;
    cells.forEach((_, i) => { cells[i] = i; });
    layout();
    win();
  });

  // --- Start ------------------------------------------------------------------

  shuffle();
  board.classList.add('instant');
  layout();
  // Let the browser place the pieces before the slide transition turns on.
  void board.offsetWidth;
  board.classList.remove('instant');
  onProgress?.(0);
}
