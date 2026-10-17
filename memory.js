// «Опознание»: a memory round. Sixteen case-file cards lie face down in a 4×4 grid; each
// suspect's face is on two of them. Tap two: a match stays open and gets a stamp, a miss
// turns back. No way to lose: the round ends when every pair is on the table.

import { sfx } from './sound.js?v=mvc4rdba';

const MISS_MS = 800;
const PAIR_MS = 250;
const WIN_MS = 600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const escape = (text) => String(text ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

export function startMemory(root, { faces, pairs, onProgress, onDone }) {
  const total = Math.min(pairs ?? 8, faces.length);
  const columns = total === 8 ? 4 : Math.min(4, Math.ceil(Math.sqrt(total * 2)));
  const deck = faces.slice(0, total).flatMap((face) => [face, face]);
  shuffle(deck);

  let open = [];
  let found = 0;
  let busy = false;
  let finished = false;

  root.innerHTML = `
    <div class="memory-board" role="application" aria-label="Карточки подозреваемых" style="--columns: ${columns}">
      ${deck.map((face, i) => `
        <button class="memory-card" type="button" data-card="${i}" aria-label="Карточка ${i + 1}">
          <span class="memory-face memory-back"><span class="memory-no">№ ${String(i + 1).padStart(2, '0')}</span><span class="memory-title">Дело</span></span>
          <span class="memory-face memory-front">
            <img src="${face.photo}" alt="${escape(face.name)}" draggable="false">
            <span class="memory-name">${escape(face.name)}</span>
            <span class="memory-stamp" aria-hidden="true">Опознан</span>
          </span>
        </button>`).join('')}
    </div>`;
  const board = root.querySelector('.memory-board');
  const cards = Array.from(board.querySelectorAll('.memory-card'));

  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  async function reveal(index) {
    const card = cards[index];
    card.classList.add('open');
    sfx.flip();
    open.push(index);
    if (open.length < 2) return;

    busy = true;
    const [a, b] = open;
    open = [];
    if (deck[a].id === deck[b].id) {
      await sleep(PAIR_MS);
      if (!root.isConnected) return;
      for (const i of [a, b]) {
        cards[i].classList.add('matched');
        cards[i].disabled = true;
      }
      sfx.pair();
      found += 1;
      onProgress?.(found / total);
      if (found === total) {
        finished = true;
        board.classList.add('solved');
        await sleep(WIN_MS);
        if (root.isConnected) onDone?.();
        return;
      }
    } else {
      await sleep(MISS_MS);
      if (!root.isConnected) return;
      sfx.miss();
      for (const i of [a, b]) cards[i].classList.remove('open');
    }
    busy = false;
  }

  board.addEventListener('click', (event) => {
    if (busy || finished) return;
    const card = event.target.closest('.memory-card');
    if (!card || card.disabled || card.classList.contains('open')) return;
    reveal(Number(card.dataset.card));
  });

  onProgress?.(0);
}
