/**
 * История изменений модели для «Отменить» и «Вернуть».
 *
 * Модель запоминается целиком, снимком: она маленькая (несколько килобайт), а
 * снимок не требует от каждого места, которое её меняет, знать про историю.
 * Записывается модель после каждой перерисовки; одинаковая — не запись.
 *
 * Непрерывное действие — перетаскивание столба, ползунок — даёт десятки
 * перерисовок в секунду. Изменения, идущие друг за другом чаще, чем раз в
 * `merge` мс, сливаются в один шаг: отмена возвращает к тому, что было до
 * начала движения, а не на один кадр назад.
 */
export function createHistory({ limit = 100, merge = 400 } = {}) {
  let undo = [];
  let redo = [];
  let current = null;
  let at = -Infinity;

  return {
    /** Начать заново с этой модели: после загрузки ссылки истории у неё ещё нет. */
    reset(model) {
      undo = [];
      redo = [];
      current = JSON.stringify(model);
      at = -Infinity;
    },

    /** Модель после перерисовки. Возвращает true, если появился новый шаг. */
    record(model, now = Date.now()) {
      const snap = JSON.stringify(model);
      if (snap === current) return false;
      const merged = now - at < merge && undo.length > 0;
      if (!merged) {
        undo.push(current);
        if (undo.length > limit) undo.shift();
      }
      redo = [];
      current = snap;
      at = now;
      return !merged;
    },

    /** Модель до последнего шага или null, если отменять нечего. */
    undo() {
      if (!undo.length) return null;
      redo.push(current);
      current = undo.pop();
      at = -Infinity; // следующее изменение — новый шаг, а не продолжение отменённого
      return JSON.parse(current);
    },

    /** Отменённый шаг обратно или null. */
    redo() {
      if (!redo.length) return null;
      undo.push(current);
      current = redo.pop();
      at = -Infinity;
      return JSON.parse(current);
    },

    get canUndo() { return undo.length > 0; },
    get canRedo() { return redo.length > 0; },
  };
}
