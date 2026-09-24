import { $ } from './dom.js';

/* ─────────────────── фоновая музыка ─────────────────── */

/**
 * Плейлист в случайном порядке, кнопка ♪ рядом с темой и ползунок громкости.
 *
 * Имена файлов заданы списком, а не читаются из папки: статическая страница
 * не может получить её содержимое — на GitHub Pages нет листинга каталога, а
 * при открытии index.html двойным кликом fetch к file:// запрещён вовсе.
 * Поэтому треки называются числами: какие из 1..8 лежат в папке, выясняется
 * при первом включении — недостающие отсеиваются по ошибке загрузки и больше
 * не трогаются. Так файл можно добавить или убрать, не трогая код.
 *
 * preload='none' — ничего не качается, пока не нажали play: у тех, кто музыку
 * не включает, страница не тяжелеет ни на байт. Сам запуск возможен только
 * после действия пользователя (браузеры блокируют автозапуск со звуком),
 * поэтому включённая в прошлый раз музыка подхватывается не при загрузке, а
 * при первом клике или нажатии клавиши.
 */
const AUDIO_DIR = 'assets/audio/';
const AUDIO_FILES = ['1.mp3', '2.mp3', '3.mp3', '4.mp3', '5.mp3', '6.mp3', '7.mp3', '8.mp3'];
const AUDIO_KEY = 'canopycraft.audio';
const AUDIO_DEFAULT = { on: false, vol: 35 };
const readAudio = () => {
  try { return { ...AUDIO_DEFAULT, ...JSON.parse(localStorage.getItem(AUDIO_KEY) ?? '{}') }; }
  catch { return { ...AUDIO_DEFAULT }; }
};
const writeAudio = (v) => { try { localStorage.setItem(AUDIO_KEY, JSON.stringify(v)); } catch { /* приватный режим */ } };

let audioState = readAudio();
let audioTag = null;
let audioPool = [...AUDIO_FILES];   // имена, которые ещё не оказались отсутствующими
let audioQueue = [];                // перемешанный порядок на текущий круг
let audioNow = null;

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Следующий трек: круг в случайном порядке, и он не начинается тем же, чем кончился прошлый. */
function nextTrack() {
  if (!audioQueue.length) {
    audioQueue = shuffle([...audioPool]);
    if (audioQueue.length > 1 && audioQueue[0] === audioNow) audioQueue.push(audioQueue.shift());
  }
  audioNow = audioQueue.shift();
  return audioNow;
}

function audioTagOf() {
  if (!audioTag) {
    audioTag = new Audio();
    audioTag.preload = 'none';
    // трек кончился — сразу следующий; файла нет — вычёркиваем и берём следующий
    audioTag.addEventListener('ended', () => { if (audioState.on) playAudio(); });
    audioTag.addEventListener('error', () => {
      if (!audioState.on) return;
      audioPool = audioPool.filter((n) => n !== audioNow);
      audioQueue = audioQueue.filter((n) => n !== audioNow);
      if (audioPool.length) { playAudio(); return; }
      audioState = { ...audioState, on: false };
      writeAudio(audioState);
      paintAudio();
      say(`Музыки нет. Положите файлы ${AUDIO_DIR}1.mp3, 2.mp3 … (до 8) в репозиторий рядом с index.html`);
    });
  }
  return audioTag;
}

function paintAudio() {
  const b = $('btn-audio');
  const vol = $('audio-vol');
  b.classList.toggle('off', !audioState.on);
  // без числа треков: до первого круга в списке ещё лежат имена, которых в
  // папке нет, и счётчик показывал бы 8 при пяти файлах
  b.title = audioState.on
    ? `Играет ${audioNow ?? '…'}. Нажмите, чтобы выключить`
    : 'Включить фоновую музыку';
  b.setAttribute('aria-pressed', String(audioState.on));
  vol.hidden = !audioState.on;
  vol.value = String(audioState.vol);
  if (audioTag) audioTag.volume = audioState.vol / 100;
}

async function playAudio() {
  const a = audioTagOf();
  a.volume = audioState.vol / 100;
  a.src = AUDIO_DIR + nextTrack();
  try { await a.play(); } catch { /* автозапуск заблокирован — ждём клика */ }
  paintAudio();
}

/**
 * Кнопка ♪ и ползунок громкости. say(текст) — подсказка человеку: музыка
 * живёт отдельно от расчёта и о перерисовке ничего не знает.
 */
let say = () => {};

export function initAudio(onSay) {
  say = onSay;
  $('btn-audio').addEventListener('click', () => {
    audioState = { ...audioState, on: !audioState.on };
    writeAudio(audioState);
    paintAudio();
    if (audioState.on) {
      audioPool = audioPool.length ? audioPool : [...AUDIO_FILES];
      audioQueue = [];
      playAudio();
    } else {
      audioTagOf().pause();
    }
  });
  $('audio-vol').addEventListener('input', (e) => {
    audioState = { ...audioState, vol: Number(e.target.value) };
    writeAudio(audioState);
    if (audioTag) audioTag.volume = audioState.vol / 100;
  });
  paintAudio();
  if (audioState.on) {
    // включена с прошлого раза: браузер даст звук только после действия пользователя
    const resume = () => {
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
      if (audioState.on) playAudio();
    };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
  }
}
