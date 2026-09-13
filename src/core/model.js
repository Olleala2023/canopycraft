/** Модель навеса и значения по умолчанию. Все длины — мм, углы — градусы. */

export function defaultModel() {
  const B = 6000, L = 4000, a = 800;
  const nRafters = 11, nPosts = 4;
  return {
    geom: {
      B,              // ширина навеса вдоль стены
      L,              // вылет от стены до оси столбов
      a,              // свес за столбы
      alpha: 8,       // уклон, °
      postHeight: 2500, // от верха фундамента до низа прогона
      driftH: 1200,   // перепад высот кровля дома / навес
    },
    site: {
      snowRegion: 'IV',
      windRegion: 'II',
      terrain: 'B',
      drift: true,
      ce: 1.0, ct: 1.0,
      cUp: 1.4, cUnder: 0.8, cDown: 0.5,
    },
    roofing: 'prof8',
    rafters: {
      xs: Array.from({ length: nRafters }, (_, i) => (B * i) / (nRafters - 1)),
      sectionId: 't50x250',
    },
    posts: {
      xs: Array.from({ length: nPosts }, (_, i) => (B * i) / (nPosts - 1)),
      sectionId: 's100x100x3',
      mu: 2.0,
    },
    purlin: { sectionId: 's80x140x4' },
    wallBeam: { sectionId: 't50x150', anchorSpacing: 900 },
    battens: { sectionId: 't50x50', spacing: 600 },
    opts: {
      timber: { grade: 2, serviceClass: 3 },
      steel: { grade: 'C245', gammaC: 1.0 },
      bearingLength: 100, // площадка опирания стропила, мм
      postEccentricity: 50,
    },
  };
}

/** Равномерно распределить n элементов по ширине B. */
export function spread(B, n) {
  return Array.from({ length: n }, (_, i) => (B * i) / (n - 1));
}

/** Грузовые ширины: половина расстояния до соседей слева и справа. */
export function tributaries(xs, B) {
  const s = [...xs].sort((p, q) => p - q);
  return s.map((x, i) => {
    const left = i === 0 ? 0 : (x - s[i - 1]) / 2;
    const right = i === s.length - 1 ? 0 : (s[i + 1] - x) / 2;
    // краевые стропила дополнительно несут свес кровли до края навеса
    const edgeLeft = i === 0 ? Math.max(0, x - 0) : 0;
    const edgeRight = i === s.length - 1 ? Math.max(0, B - x) : 0;
    return left + right + edgeLeft + edgeRight;
  });
}
