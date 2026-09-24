import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../src/ui/history.js';

const m = (B) => ({ geom: { B } });

test('отмена и возврат по шагам', () => {
  const h = createHistory();
  h.reset(m(6000));
  assert.equal(h.canUndo, false, 'в начале отменять нечего');
  h.record(m(7000), 1000);
  h.record(m(8000), 2000);
  assert.deepEqual(h.undo(), m(7000));
  assert.deepEqual(h.undo(), m(6000));
  assert.equal(h.undo(), null, 'дальше начала не отменяется');
  assert.deepEqual(h.redo(), m(7000));
  assert.deepEqual(h.redo(), m(8000));
  assert.equal(h.redo(), null);
});

test('та же модель после перерисовки — не шаг', () => {
  const h = createHistory();
  h.reset(m(6000));
  assert.equal(h.record(m(6000), 1000), false);
  assert.equal(h.canUndo, false);
});

test('перетаскивание и ползунок — один шаг, а не кадр', () => {
  const h = createHistory({ merge: 400 });
  h.reset(m(6000));
  for (let t = 1000, B = 6000; t < 3000; t += 16) h.record(m((B += 10)), t);
  assert.deepEqual(h.undo(), m(6000), 'отмена возвращает к началу движения');
  assert.equal(h.canUndo, false);
});

test('изменения с паузой — отдельные шаги', () => {
  const h = createHistory({ merge: 400 });
  h.reset(m(6000));
  h.record(m(7000), 1000);
  h.record(m(8000), 1500);
  assert.deepEqual(h.undo(), m(7000));
});

test('новое изменение после отмены стирает то, что можно было вернуть', () => {
  const h = createHistory();
  h.reset(m(6000));
  h.record(m(7000), 1000);
  h.undo();
  h.record(m(9000), 5000);
  assert.equal(h.canRedo, false);
  assert.deepEqual(h.undo(), m(6000));
});

test('после отмены новое изменение — отдельный шаг, даже сразу', () => {
  const h = createHistory({ merge: 400 });
  h.reset(m(6000));
  h.record(m(7000), 1000);
  h.record(m(8000), 2000);
  h.undo(); // → 7000
  h.record(m(7500), 2010);
  assert.deepEqual(h.undo(), m(7000), 'изменение слилось с отменённым шагом');
});

test('история не растёт бесконечно', () => {
  const h = createHistory({ limit: 3, merge: 0 });
  h.reset(m(0));
  for (let i = 1; i <= 10; i++) h.record(m(i), i * 1000);
  let n = 0;
  while (h.undo()) n++;
  assert.equal(n, 3);
});

test('снимок не зависит от дальнейших правок модели', () => {
  const h = createHistory();
  const model = m(6000);
  h.reset(model);
  model.geom.B = 7000; // модель правят на месте, как это делает интерфейс
  h.record(model, 1000);
  model.geom.B = 8000;
  h.record(model, 2000);
  assert.deepEqual(h.undo(), m(7000));
  assert.deepEqual(h.undo(), m(6000));
});
