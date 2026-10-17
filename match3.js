// A small match-3 round: swipe (or tap two neighbours) to swap, runs of three or more clear,
// tiles fall, new ones drop in. No move limit and no way to lose: the round ends when the goals
// are collected. A board without a possible move reshuffles; an idle player gets a hint.

import { sfx } from './sound.js?v=mvc4rdba';

const SIZE = 7;
const SWAP_MS = 180;
const POP_MS = 220;
const FALL_MS = 260;
const HINT_AFTER_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function startPuzzle(root, { tiles, goals, onProgress, onDone }) {
  const kindIndex = Object.fromEntries(tiles.map((tile, index) => [tile.id, index]));
  const goalKinds = goals.map((goal) => kindIndex[goal.tile]);
  const collected = goals.map(() => 0);
  let grid = [];
  let nextKey = 0;
  let busy = false;
  let finished = false;
  let hintTimer;
  let hinted = [];

  root.innerHTML = `
    <div class="goals">${goals.map((goal, i) => `
      <div class="goal" data-goal="${i}">
        <span class="goal-tile">${tileFace(tiles[goalKinds[i]])}</span>
        <span class="goal-count">0 / ${goal.count}</span>
      </div>`).join('')}
    </div>
    <div class="board" role="application" aria-label="Поле с фишками"></div>`;
  const board = root.querySelector('.board');

  // --- Model ----------------------------------------------------------------

  function randomKind() {
    // Goal tiles come a bit more often, so a round stays around a minute.
    const weights = tiles.map((_, kind) => (goalKinds.includes(kind) ? 1.35 : 1));
    let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let kind = 0; kind < weights.length; kind += 1) {
      roll -= weights[kind];
      if (roll < 0) return kind;
    }
    return weights.length - 1;
  }

  function kindAt(r, c) {
    return grid[r]?.[c]?.kind;
  }

  function fillWithoutMatches() {
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        let kind;
        do {
          kind = randomKind();
        } while (
          (c >= 2 && kindAt(r, c - 1) === kind && kindAt(r, c - 2) === kind)
          || (r >= 2 && kindAt(r - 1, c) === kind && kindAt(r - 2, c) === kind)
        );
        grid[r][c].kind = kind;
      }
    }
  }

  function findMatches() {
    const cells = new Set();
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        const kind = kindAt(r, c);
        if (kind === undefined) continue;
        if (c <= SIZE - 3 && kindAt(r, c + 1) === kind && kindAt(r, c + 2) === kind) {
          for (let k = c; k < SIZE && kindAt(r, k) === kind; k += 1) cells.add(`${r},${k}`);
        }
        if (r <= SIZE - 3 && kindAt(r + 1, c) === kind && kindAt(r + 2, c) === kind) {
          for (let k = r; k < SIZE && kindAt(k, c) === kind; k += 1) cells.add(`${k},${c}`);
        }
      }
    }
    return cells;
  }

  function swapCells([r1, c1], [r2, c2]) {
    [grid[r1][c1], grid[r2][c2]] = [grid[r2][c2], grid[r1][c1]];
  }

  function findMove() {
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        for (const [dr, dc] of [[0, 1], [1, 0]]) {
          const other = [r + dr, c + dc];
          if (other[0] >= SIZE || other[1] >= SIZE) continue;
          swapCells([r, c], other);
          const works = findMatches().size > 0;
          swapCells([r, c], other);
          if (works) return [[r, c], other];
        }
      }
    }
    return null;
  }

  function progress() {
    const total = goals.reduce((sum, goal) => sum + goal.count, 0);
    const done = goals.reduce((sum, goal, i) => sum + Math.min(collected[i], goal.count), 0);
    return done / total;
  }

  // --- View -----------------------------------------------------------------

  function tileFace(tile) {
    return tile.photo ? `<img src="${tile.photo}" alt="">` : `<span>${tile.emoji}</span>`;
  }

  function createTile(kind, r, c, fromRow = r) {
    const element = document.createElement('div');
    element.className = 'tile';
    element.innerHTML = tileFace(tiles[kind]);
    const cell = { key: nextKey += 1, kind, element };
    position(cell, fromRow, c);
    board.append(element);
    return cell;
  }

  function position(cell, r, c) {
    cell.element.style.transform = `translate(${c * 100}%, ${r * 100}%)`;
  }

  function layout() {
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) position(grid[r][c], r, c);
    }
  }

  function renderGoals() {
    goals.forEach((goal, i) => {
      const element = root.querySelector(`[data-goal="${i}"]`);
      element.querySelector('.goal-count').textContent = `${Math.min(collected[i], goal.count)} / ${goal.count}`;
      element.classList.toggle('done', collected[i] >= goal.count);
    });
  }

  function clearHint() {
    clearTimeout(hintTimer);
    for (const cell of hinted) cell.element.classList.remove('hint');
    hinted = [];
  }

  function scheduleHint() {
    clearHint();
    hintTimer = setTimeout(() => {
      if (!board.isConnected || busy || finished) return;
      const move = findMove();
      if (!move) return;
      hinted = move.map(([r, c]) => grid[r][c]);
      for (const cell of hinted) cell.element.classList.add('hint');
    }, HINT_AFTER_MS);
  }

  // --- Turn -----------------------------------------------------------------

  async function clearMatches(cells) {
    const before = collected.slice();
    for (const id of cells) {
      const [r, c] = id.split(',').map(Number);
      const cell = grid[r][c];
      const goal = goalKinds.indexOf(cell.kind);
      if (goal !== -1) collected[goal] += 1;
      cell.element.classList.add('pop');
    }
    renderGoals();
    onProgress?.(progress());
    if (goals.some((goal, i) => before[i] < goal.count && collected[i] >= goal.count)) sfx.goalDone();
    else if (collected.some((count, i) => count > before[i])) sfx.goalTick();
    await sleep(POP_MS);
    for (const id of cells) {
      const [r, c] = id.split(',').map(Number);
      grid[r][c].element.remove();
      grid[r][c] = null;
    }
  }

  async function collapse() {
    const dropped = [];
    for (let c = 0; c < SIZE; c += 1) {
      const column = [];
      for (let r = SIZE - 1; r >= 0; r -= 1) if (grid[r][c]) column.push(grid[r][c]);
      const missing = SIZE - column.length;
      for (let k = 0; k < missing; k += 1) {
        // New tiles start above the board, stacked in the order they will land.
        const cell = createTile(randomKind(), 0, c, -1 - k);
        column.push(cell);
        dropped.push(cell);
      }
      column.forEach((cell, index) => {
        grid[SIZE - 1 - index][c] = cell;
      });
    }
    // Let the browser paint the new tiles above the board before they fall.
    for (const cell of dropped) void cell.element.offsetWidth;
    layout();
    await sleep(FALL_MS);
  }

  async function reshuffle() {
    sfx.shuffle();
    board.classList.add('shuffling');
    await sleep(200);
    do {
      fillWithoutMatches();
    } while (!findMove());
    for (const row of grid) for (const cell of row) cell.element.innerHTML = tileFace(tiles[cell.kind]);
    board.classList.remove('shuffling');
    await sleep(200);
  }

  async function trySwap(a, b) {
    busy = true;
    clearHint();
    sfx.swap();
    swapCells(a, b);
    layout();
    await sleep(SWAP_MS);

    let matches = findMatches();
    if (!matches.size) {
      sfx.invalid();
      swapCells(a, b);
      layout();
      await sleep(SWAP_MS);
      busy = false;
      scheduleHint();
      return;
    }
    let cascade = 0;
    while (matches.size) {
      sfx.match(cascade);
      cascade += 1;
      await clearMatches(matches);
      await collapse();
      matches = findMatches();
    }
    if (collected.every((count, i) => count >= goals[i].count)) {
      finished = true;
      board.classList.add('solved');
      sfx.won();
      onDone?.();
      return;
    }
    if (!findMove()) await reshuffle();
    busy = false;
    scheduleHint();
  }

  // --- Input: swipe, or tap two neighbours -----------------------------------

  let start = null;
  let selected = null;

  function cellFromPoint(event) {
    const rect = board.getBoundingClientRect();
    const c = Math.floor(((event.clientX - rect.left) / rect.width) * SIZE);
    const r = Math.floor(((event.clientY - rect.top) / rect.height) * SIZE);
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE ? [r, c] : null;
  }

  function select(cell) {
    if (selected) grid[selected[0]][selected[1]]?.element.classList.remove('selected');
    selected = cell;
    if (cell) grid[cell[0]][cell[1]].element.classList.add('selected');
  }

  board.addEventListener('pointerdown', (event) => {
    if (busy || finished) return;
    const cell = cellFromPoint(event);
    if (!cell) return;
    start = { cell, x: event.clientX, y: event.clientY, swiped: false };
    board.setPointerCapture(event.pointerId);
  });

  board.addEventListener('pointermove', (event) => {
    if (!start || start.swiped || busy) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const threshold = board.clientWidth / SIZE / 3;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return;
    start.swiped = true;
    const [r, c] = start.cell;
    const target = Math.abs(dx) > Math.abs(dy) ? [r, c + Math.sign(dx)] : [r + Math.sign(dy), c];
    select(null);
    if (target[0] >= 0 && target[0] < SIZE && target[1] >= 0 && target[1] < SIZE) trySwap(start.cell, target);
  });

  board.addEventListener('pointerup', () => {
    if (!start || busy) {
      start = null;
      return;
    }
    if (!start.swiped) {
      const cell = start.cell;
      const adjacent = selected && Math.abs(selected[0] - cell[0]) + Math.abs(selected[1] - cell[1]) === 1;
      if (adjacent) {
        const from = selected;
        select(null);
        trySwap(from, cell);
      } else {
        select(selected && selected[0] === cell[0] && selected[1] === cell[1] ? null : cell);
      }
    }
    start = null;
  });

  board.addEventListener('pointercancel', () => {
    start = null;
  });

  // --- Start ------------------------------------------------------------------

  grid = Array.from({ length: SIZE }, (_, r) => Array.from({ length: SIZE }, (_, c) => createTile(0, r, c)));
  do {
    fillWithoutMatches();
  } while (!findMove());
  for (const row of grid) for (const cell of row) cell.element.innerHTML = tileFace(tiles[cell.kind]);
  renderGoals();
  onProgress?.(0);
  scheduleHint();
}
