/*
 * Lily Garden — une scène de lys vivante en pixel art.
 *
 * Principe de rendu
 * -----------------
 *  - Toute la scène est composée dans un petit framebuffer (≈ 200 × 426 px
 *    en portrait) sous forme de Uint32Array : chaque pixel est posé
 *    explicitement, il n'y a jamais d'antialiasing.
 *  - Ce framebuffer est ensuite agrandi d'un facteur ENTIER, en
 *    nearest-neighbor, sur un canvas à la résolution physique de l'écran.
 *  - Les éléments statiques (ciel, haie lointaine, fleurs, feuilles) sont
 *    pré-calculés une fois dans des buffers hors écran (Sprite) à partir de
 *    graines fixes ; seules leurs positions changent d'une image à l'autre.
 *  - Toute l'animation est une fonction pure du temps t modulo
 *    CONFIG.loop : toutes les fréquences sont des multiples entiers de
 *    2π / loop, la boucle est donc parfaite.
 *
 * Organisation
 * ------------
 *  Config & palettes → utilitaires (RNG, couleurs) → Sprite / Frame
 *  → LilyFlower (fleur) → LilyBud (bouton) → LilyLeaf (feuille) → Wind
 *  → LilyPlant (tiges + feuilles + fleurs) → GroundCover
 *  → Background / Sky / Motes / PetalSystem → Scene → App
 */
(function () {
  'use strict';

  // ===================================================================
  // Configuration
  // ===================================================================

  const CONFIG = {
    targetHeight: 426,   // hauteur interne visée en portrait, en « pixels art »
    targetHeightLandscape: 250, // en paysage : des pixels plus gros, la scène reste lisible sur téléphone
    loop: 48,            // durée de la boucle parfaite (secondes)
    seed: 0x11ac,        // graine globale : changer pour un autre jardin
    petalsPerLoop: 9,    // pétales qui tombent par boucle (rares)
    heartsPerLoop: 3,    // petits cœurs qui s'élèvent des fleurs
    fireworkTimes: [0.5, 16.5, 32.5], // instants (s) des salves de cœurs : dès l'ouverture, puis toutes les 16 s
    stillTime: 4,        // instant figé si prefers-reduced-motion (cœurs ouverts)
    promptTime: 15.9,    // image calme (sans feu d'artifice) derrière l'invitation à tourner le téléphone
  };

  const T = CONFIG.loop;
  const TAU = Math.PI * 2;

  // Palettes (du plus sombre au plus clair).
  const PALETTE = {
    // Lys : 8 tons de pétale, couleur des mouchetures, nombre de mouchetures par pétale
    lily: {
      stargazer: { petal: ['#3a0f2c', '#6a1a4a', '#a42a6a', '#d04489', '#e8679f', '#f39cc0', '#fbd2e3', '#fff2f8'], spot: '#7a1240', spots: 7 },
      white:     { petal: ['#33303c', '#5f5a68', '#9a93a2', '#c9c3ce', '#e4dfe7', '#f2eff4', '#faf8fb', '#ffffff'], spot: '#c9a3b8', spots: 0 },
      blush:     { petal: ['#3c1a2c', '#6e3050', '#a65377', '#cf7ea0', '#e8a7c1', '#f5c9da', '#fce5ee', '#fffafc'], spot: '#9c3a62', spots: 3 },
    },
    throat: ['#2d4a30', '#5f8a4a', '#a6c46c', '#dfe8a0'],
    stamen: ['#d6e2b0', '#5a210d', '#a8481a', '#9cbc68', '#c4dc8c'],  // filet, anthère ×2, pistil, stigmate
    leaf: ['#121c1b', '#1c2e29', '#284036', '#385846', '#557F69', '#6c9a7e', '#8db897'],
    bark: ['#19151f', '#2b2430', '#43383f', '#5f5049'],
    twig: ['#1a241f', '#2c3f33', '#405a45', '#577656'],
    // de l'indigo du zénith au rose crépusculaire de l'horizon
    sky:  ['#0d0b1c', '#121024', '#16132b', '#1b1633', '#21193b', '#281d42', '#312148', '#3b254f', '#472a55', '#53305b', '#60365f'],
    hedge: ['#140f22', '#1a1329', '#221832'],
    moon: ['#fff6fa', '#f6e4ef', '#e6cde0', '#cdb3cf', '#a78fb4'],
    petal: ['#f39cc0', '#fbd2e3', '#fff2f8', '#ffffff'],
    rose: ['#ff9ec4', '#ffc4dc', '#ffe6f0'],
    // bouquet rose et blanc
    peony: {
      pink:  ['#2c1024', '#5a1f45', '#93366a', '#c75688', '#e47fa8', '#f3a9c6', '#fbd2e3', '#fff0f6'],
      white: ['#2e1f2e', '#664e63', '#a38aa0', '#cbb4c7', '#e5d6e1', '#f4ebf1', '#fcf7fa', '#ffffff'],
    },
    wrapPink:  ['#4a2340', '#b5577f', '#e08aac', '#f4b6cd', '#fbd7e5'],
    wrapWhite: ['#4a3446', '#c9b6c4', '#e7dbe3', '#f6eff3', '#fffbfd'],
    ribbon:    ['#5a1430', '#b02f62', '#e45a8c', '#ff8db5', '#ffc2d9'],
    bouquetLine: '#24122a',
  };

  // Échelle de composition, fixée par Scene selon la hauteur interne :
  //   vs : hauteur des tiges (1 en portrait, ~0.6 en paysage)
  //   fs : taille des fleurs et des feuilles
  const LAYOUT = { vs: 1, fs: 1 };

  const FOG = [22, 20, 42];              // couleur vers laquelle tirent les plans lointains
  const LIGHT = norm3(-0.55, -0.68, 0.5); // lumière lunaire : haut-gauche, face

  // ===================================================================
  // Utilitaires
  // ===================================================================

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Générateur pseudo-aléatoire déterministe (graine fixe). */
  class Rng {
    constructor(seed) { this.next = mulberry32(seed >>> 0); }
    float(a = 0, b = 1) { return a + (b - a) * this.next(); }
    int(a, b) { return Math.floor(this.float(a, b + 1)); }
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
    chance(p) { return this.next() < p; }
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
  function norm3(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }

  // Couleurs empaquetées en Uint32 compatibles avec ImageData.
  const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  function pack(r, g, b) {
    return LITTLE_ENDIAN
      ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0
      : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
  }
  function unpack(c) {
    return LITTLE_ENDIAN
      ? [c & 255, (c >>> 8) & 255, (c >>> 16) & 255]
      : [c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255];
  }
  function hexRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mixRgb(a, b, t) {
    return [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];
  }
  /** Convertit une rampe hex en couleurs empaquetées, voilée par la profondeur. */
  function ramp(hexes, fog = 0) {
    return hexes.map((h) => {
      let c = hexRgb(h);
      if (fog > 0) c = mixRgb(c, FOG, fog);
      return pack(c[0], c[1], c[2]);
    });
  }

  // ===================================================================
  // Buffers de pixels
  // ===================================================================

  /** Image hors écran pré-calculée. 0 = transparent. (ax, ay) = point d'ancrage. */
  class Sprite {
    constructor(w, h, ax = 0, ay = 0) {
      this.w = w; this.h = h; this.ax = ax; this.ay = ay;
      this.px = new Uint32Array(w * h);
    }
    get(x, y) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : this.px[y * this.w + x]; }
    set(x, y, c) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = c; }
    disk(cx, cy, r, c) {
      const R = Math.ceil(r);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy <= r * r + 0.35) this.set(Math.round(cx) + dx, Math.round(cy) + dy, c);
        }
      }
    }
    /** Recadre sur les pixels opaques (l'ancre est conservée). */
    crop() {
      let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
      for (let y = 0; y < this.h; y++) {
        for (let x = 0; x < this.w; x++) {
          if (this.px[y * this.w + x]) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return new Sprite(1, 1, 0, 0);
      const out = new Sprite(x1 - x0 + 1, y1 - y0 + 1, this.ax - x0, this.ay - y0);
      for (let y = y0; y <= y1; y++) {
        out.px.set(this.px.subarray(y * this.w + x0, y * this.w + x1 + 1), (y - y0) * out.w);
      }
      return out;
    }
  }

  /** Framebuffer de l'image courante (vue Uint32 sur un ImageData). */
  class Frame {
    constructor(w, h, u32) { this.w = w; this.h = h; this.px = u32; }
    plot(x, y, c) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = c; }
    /** Mélange une couleur [r,g,b] avec une opacité a (lueurs, fondus). */
    blend(x, y, rgb, a) {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0.004) return;
      const i = y * this.w + x;
      const d = unpack(this.px[i]);
      a = Math.min(1, a);
      this.px[i] = pack(
        (d[0] + (rgb[0] - d[0]) * a) | 0,
        (d[1] + (rgb[1] - d[1]) * a) | 0,
        (d[2] + (rgb[2] - d[2]) * a) | 0);
    }
    /** Assombrit toute l'image (facteur 0..1), sans allocation. */
    dim(f) {
      const px = this.px;
      for (let i = 0; i < px.length; i++) {
        const c = px[i];
        if (LITTLE_ENDIAN) {
          px[i] = ((255 << 24) | ((((c >>> 16) & 255) * f) << 16) | ((((c >>> 8) & 255) * f) << 8) | ((c & 255) * f)) >>> 0;
        } else {
          const d = unpack(c);
          px[i] = pack(d[0] * f | 0, d[1] * f | 0, d[2] * f | 0);
        }
      }
    }
    /** Copie un sprite (coin haut-gauche en x, y). */
    blit(sp, x, y) {
      for (let r = 0; r < sp.h; r++) this.blitRow(sp, r, x, y + r);
    }
    /** Copie une seule ligne d'un sprite : permet de « cisailler » une fleur. */
    blitRow(sp, row, x, y) {
      if (y < 0 || y >= this.h) return;
      const x0 = Math.max(0, x), x1 = Math.min(this.w, x + sp.w);
      let si = row * sp.w + (x0 - x), di = y * this.w + x0;
      for (let xx = x0; xx < x1; xx++, si++, di++) {
        const c = sp.px[si];
        if (c) this.px[di] = c;
      }
    }
  }

  // ===================================================================
  // Fleur de lys (six tépales en étoile, étamines saillantes)
  // ===================================================================
  /*
   * Un lys (Lilium) vu de trois quarts : six tépales pointus disposés en
   * étoile autour d'une gorge verte, à pointe recourbée vers l'arrière,
   * pliés le long de leur nervure. Six étamines aux anthères orangées et un
   * pistil vert sortent du cœur. Sur les lys roses, des mouchetures sombres.
   *
   * Le plan de la fleur est projeté selon :
   *   facing : direction (écran) vers laquelle la fleur s'ouvre, 0 = haut
   *   open   : 1 = vue de face, ~0.4 = presque de profil (trompette visible)
   * Chaque pixel passe par un z-buffer pour que les tépales proches
   * recouvrent les tépales lointains et la trompette.
   */
  class LilyFlower {
    constructor({ seed, size, facing, open, palette, fog, outline = true }) {
      const rng = new Rng(seed);
      const R = size;
      const pal = PALETTE.lily[palette];
      const c = ramp(pal.petal, fog);
      const spotC = ramp([pal.spot], fog)[0];
      const th = ramp(PALETTE.throat, fog);
      const st = ramp(PALETTE.stamen, fog);
      const d = [Math.sin(facing), -Math.cos(facing)];   // ouverture de la fleur, à l'écran
      const a1 = [-d[1], d[0]];                          // axe transversal, vu en entier
      const sq = Math.sqrt(1 - open * open);
      const tube = R * (0.2 + 0.5 * sq);
      const C = [d[0] * tube, d[1] * tube];              // cœur de la fleur
      const L2 = [LIGHT[0], LIGHT[1]];

      const S = Math.ceil(R * 2.2 + tube) + 4, N = 2 * S + 1;
      const sp = new Sprite(N, N, S, S);
      const zbuf = new Float32Array(N * N).fill(-1e9);
      const plot = (x, y, z, col) => {
        const X = Math.round(x) + S, Y = Math.round(y) + S;
        if (X < 0 || Y < 0 || X >= N || Y >= N) return;
        const i = Y * N + X;
        if (z >= zbuf[i]) { zbuf[i] = z; sp.px[i] = col; }
      };

      // Trompette : du pédoncule vers le cœur, verte puis rosée.
      for (let k = 0; k <= 1.0001; k += 0.5 / Math.max(1, tube)) {
        const hw = lerp(0.8, R * 0.3, k * k);
        for (let t = -hw; t <= hw; t += 0.5) {
          const lit = (a1[0] * L2[0] + a1[1] * L2[1]) * t < 0;
          const col = k < 0.55 ? th[lit ? 2 : 1] : c[lit ? 4 : 3];
          plot(d[0] * tube * k + a1[0] * t, d[1] * tube * k + a1[1] * t, -R * 2, col);
        }
      }

      // Six tépales : trois extérieurs plus étroits, trois intérieurs plus larges.
      const rot = rng.float(0, TAU / 6);
      for (let i = 0; i < 6; i++) {
        const phi = rot + (i * TAU) / 6 + rng.float(-0.08, 0.08);
        const Wp = R * (i % 2 ? 0.25 : 0.32);
        const Lp = R * rng.float(0.92, 1.05);
        const curl = R * rng.float(0.28, 0.42);
        const dir = [Math.cos(phi), Math.sin(phi)], nrm = [-dir[1], dir[0]];
        // direction écran du tépale et de son demi-plan « gauche »
        const sd = [a1[0] * dir[0] + d[0] * dir[1] * open, a1[1] * dir[0] + d[1] * dir[1] * open];
        const sn = [a1[0] * nrm[0] + d[0] * nrm[1] * open, a1[1] * nrm[0] + d[1] * nrm[1] * open];
        const litHalf = sn[0] * L2[0] + sn[1] * L2[1] > 0 ? 1 : -1;
        const spots = [];
        for (let k = 0; k < pal.spots; k++) spots.push([rng.float(0.2, 0.55), rng.float(-0.55, 0.55)]);

        for (let u = 0.04; u <= 1.0001; u += 0.35 / Lp) {
          const w = Wp * Math.sin(Math.PI * Math.pow(u, 0.72));
          const back = curl * Math.pow(Math.max(0, u - 0.55) / 0.45, 2);   // recourbure de la pointe
          for (let t = -1; t <= 1.0001; t += 0.35 / Math.max(1, w)) {
            const pu = dir[0] * u * Lp + nrm[0] * t * w;
            const pv = dir[1] * u * Lp + nrm[1] * t * w;
            const x = C[0] + a1[0] * pu + d[0] * pv * open - d[0] * back * sq;
            const y = C[1] + a1[1] * pu + d[1] * pv * open - d[1] * back * sq;
            const z = -pv * sq - back * open;
            let col;
            if (u < 0.15) {
              col = th[u < 0.08 ? 2 : 3];                                   // gorge verte
            } else {
              let idx = 5;
              if (u < 0.32) idx = 4;                                         // cœur plus soutenu
              if (Math.abs(t) > 0.7) idx = 6;                                // bord pâle
              if (Math.abs(t) < 0.18 && u < 0.85) idx = 3;                   // nervure en creux
              else idx += (t >= 0 ? 1 : -1) === litHalf ? 1 : -1;           // tépale plié le long de la nervure
              if (back > curl * 0.35) idx -= 1;                              // revers de la pointe recourbée
              if (u > 0.93) idx = Math.min(idx, 5);
              col = c[clamp(idx, 1, 7)];
              for (const [su, stt] of spots) {
                if (Math.abs(u - su) < 0.05 && Math.abs(t - stt) < 0.14) col = spotC;
              }
            }
            plot(x, y, z, col);
          }
        }
      }

      // Étamines et pistil, devant les tépales.
      const Ls = R * 0.78;
      for (let j = 0; j < 6; j++) {
        const ang = rot + (j * TAU) / 6 + 0.5;
        const ex = C[0] + d[0] * sq * Ls * 0.85 + (a1[0] * Math.cos(ang) + d[0] * Math.sin(ang) * open) * Ls * 0.42;
        const ey = C[1] + d[1] * sq * Ls * 0.85 + (a1[1] * Math.cos(ang) + d[1] * Math.sin(ang) * open) * Ls * 0.42;
        const steps = Math.max(2, Math.ceil(Math.hypot(ex - C[0], ey - C[1]) * 2));
        for (let k = 2; k <= steps; k++) plot(lerp(C[0], ex, k / steps), lerp(C[1], ey, k / steps), 1e5, st[0]);
        plot(ex, ey, 1e5 + 1, st[2]);
        plot(ex + a1[0], ey + a1[1], 1e5 + 1, st[1]);
      }
      const px = C[0] + d[0] * sq * Ls, py = C[1] + d[1] * sq * Ls;
      for (let k = 2; k <= 8; k++) plot(lerp(C[0], px, k / 8), lerp(C[1], py, k / 8), 1e5 + 2, st[3]);
      plot(px, py, 1e5 + 3, st[4]);

      // Contour : sombre côté ombre, plus doux ailleurs (le bouquet a le sien).
      const src = sp.px.slice();
      for (let y = 0; y < N && outline; y++) {
        for (let x = 0; x < N; x++) {
          if (src[y * N + x]) continue;
          const l = x > 0 && src[y * N + x - 1], r = x < N - 1 && src[y * N + x + 1];
          const u = y > 0 && src[(y - 1) * N + x], b = y < N - 1 && src[(y + 1) * N + x];
          if (l || u) sp.px[y * N + x] = c[0];
          else if (r || b) sp.px[y * N + x] = c[1];
        }
      }

      this.sprite = sp.crop();
      this.length = R * 1.6;
      // pixels clairs des tépales : départ des pétales qui tombent, scintillements
      const out = this.sprite, light = [c[5], c[6]];
      this.front = [];
      for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) if (light.includes(out.px[y * out.w + x])) this.front.push([x, y]);
      this.sparkles = [];
      for (let k = 0; k < 2 && this.front.length; k++) {
        const [x, y] = rng.pick(this.front);
        this.sparkles.push({ x, y, n: rng.int(2, 5), ph: rng.float(0, TAU) });
      }
    }
  }

  // ===================================================================
  // Bouton de lys (fuseau fermé, vert à la base)
  // ===================================================================
  class LilyBud {
    constructor({ seed, length, facing, palette, fog }) {
      const rng = new Rng(seed);
      const c = ramp(PALETTE.lily[palette].petal, fog);
      const th = ramp(PALETTE.throat, fog);
      const d = [Math.sin(facing), -Math.cos(facing)], a1 = [-d[1], d[0]];
      const litSide = a1[0] * LIGHT[0] + a1[1] * LIGHT[1] > 0 ? 1 : -1;
      const Wb = Math.max(2, length * 0.2);
      const S = Math.ceil(length) + 4, N = 2 * S + 1;
      const sp = new Sprite(N, N, S, S);
      for (let u = 0; u <= 1.0001; u += 0.35 / length) {
        const w = Wb * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.62)), 0.8);
        for (let t = -1; t <= 1.0001; t += 0.35 / Math.max(1, w)) {
          const x = Math.round(d[0] * u * length + a1[0] * t * w), y = Math.round(d[1] * u * length + a1[1] * t * w);
          const lit = (t >= 0 ? 1 : -1) === litSide;
          let col;
          if (u < 0.3) col = th[lit ? 2 : 1];
          else {
            let idx = (u < 0.55 ? 3 : 4) + (lit ? 1 : 0);
            if (Math.abs(Math.abs(t) - 0.4) < 0.12) idx -= 1;  // sutures des tépales
            col = c[clamp(idx, 1, 7)];
          }
          sp.set(x + S, y + S, col);
        }
      }
      const src = sp.px.slice();
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (src[y * N + x]) continue;
        if ((x > 0 && src[y * N + x - 1]) || (y > 0 && src[(y - 1) * N + x]) ||
            (x < N - 1 && src[y * N + x + 1]) || (y < N - 1 && src[(y + 1) * N + x])) sp.px[y * N + x] = c[0];
      }
      this.sprite = sp.crop();
      this.length = length;
      this.front = [];
      this.sparkles = [];
      void rng;
    }
  }

  // ===================================================================
  // Feuille de lys (lancéolée, étroite, légèrement arquée)
  // ===================================================================
  class LilyLeaf {
    constructor({ seed, length, width, angle, bend = 0, fog }) {
      const rng = new Rng(seed);
      const c = ramp(PALETTE.leaf, fog);
      const dir = [Math.cos(angle), Math.sin(angle)], perp = [-dir[1], dir[0]];
      const S = Math.ceil(length + Math.abs(bend)) + 4, N = 2 * S + 1;
      const sp = new Sprite(N, N, S, S);
      const side = new Int8Array(N * N);
      const lightSide = perp[0] * LIGHT[0] + perp[1] * LIGHT[1] > 0 ? 1 : -1;
      const half = width / 2;
      for (let u = 0; u <= 1.0001; u += 0.35 / length) {
        const w = Math.max(0.3, half * Math.sin(Math.PI * Math.pow(u, 0.55)));
        const off = bend * u * u;
        for (let t = -1; t <= 1.0001; t += 0.35 / Math.max(1, w)) {
          const along = u * length, across = off + t * w;
          const X = Math.round(dir[0] * along + perp[0] * across) + S;
          const Y = Math.round(dir[1] * along + perp[1] * across) + S;
          if (X < 0 || Y < 0 || X >= N || Y >= N) continue;
          const lit = (t >= 0 ? 1 : -1) === lightSide;
          let idx = Math.abs(t) < 0.22 && u < 0.9 ? 5 : lit ? 4 : 3;
          if (u < 0.1) idx = 3;
          if (!lit && u > 0.6 && rng.chance(0.15)) idx = 2;
          sp.px[Y * N + X] = c[idx];
          side[Y * N + X] = 1;
        }
      }
      const src = sp.px.slice();
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (src[y * N + x]) continue;
        if ((x > 0 && src[y * N + x - 1]) || (y > 0 && src[(y - 1) * N + x]) ||
            (x < N - 1 && src[y * N + x + 1]) || (y < N - 1 && src[(y + 1) * N + x])) sp.px[y * N + x] = c[1];
      }
      this.sprite = sp.crop();
    }
  }

  // ===================================================================
  // Vent : déplacement horizontal en fonction de la hauteur relative s
  // ===================================================================
  /*
   * s = 0 à la racine, 1 au sommet du buisson. Deux sinusoïdes de
   * fréquences entières (boucle parfaite), déphasées selon s pour que
   * l'onde « monte » le long des tiges, modulées par une rafale lente.
   */
  class Wind {
    constructor(rng, amp) {
      this.amp = amp;
      this.w1 = (TAU * rng.pick([4, 5, 6])) / T;
      this.w2 = (TAU * rng.pick([7, 8, 9, 10])) / T;
      this.p1 = rng.float(0, TAU);
      this.p2 = rng.float(0, TAU);
      this.p3 = rng.float(0, TAU);
    }
    sway(s, t) {
      const e = Math.pow(Math.max(0, s), 1.5);
      const gust = 0.7 + 0.3 * Math.sin((TAU * t) / T + this.p3);
      return this.amp * e * gust *
        (0.68 * Math.sin(this.w1 * t + this.p1 - 1.7 * s) + 0.32 * Math.sin(this.w2 * t + this.p2 - 1.1 * s));
    }
    /** Phase locale du vent (sert à faire basculer les feuilles). */
    phase(s, t) { return Math.sin(this.w1 * t + this.p1 - 1.7 * s - 0.9); }
  }

  // ===================================================================
  // Pied de lys : hautes tiges, feuilles alternes, fleurs au sommet
  // ===================================================================

  /*
   * Gabarits de composition, en pixels relatifs à la racine.
   *   parent / at : tige porteuse et position (0..1) du départ
   *   to     : extrémité de la tige ou du pédoncule
   *   bend   : courbure (décalage du point de contrôle)
   *   th     : épaisseur [base, pointe]
   *   leaves : true → feuilles alternes le long de la tige
   *   flower : { R: taille, open: ouverture vue de face (0..1), pal }
   *   bud    : { len }
   */
  const TEMPLATES = {
    edge: {
      amp: 2.4,
      leafSize: [14, 20],
      branches: [
        { parent: null, to: [38, -172], bend: -8, th: [3, 2], leaves: true },
        { parent: 0, at: 0.92, to: [16, -7], bend: 2, th: [1, 1], flower: { R: 19, open: 0.72, pal: 'stargazer' } },
        { parent: 0, at: 0.98, to: [-13, -10], bend: -2, th: [1, 1], flower: { R: 16, open: 0.55, pal: 'stargazer' } },
        { parent: 0, at: 1, to: [2, -13], bend: 1, th: [1, 1], bud: { len: 13 } },
        { parent: null, to: [74, -100], bend: 12, th: [2, 2], leaves: true },
        { parent: 4, at: 0.95, to: [12, -6], bend: 2, th: [1, 1], flower: { R: 16, open: 0.62, pal: 'white' } },
        { parent: 4, at: 1, to: [0, -11], bend: 1, th: [1, 1], bud: { len: 11 } },
        { parent: null, to: [16, -232], bend: -6, th: [2, 2], leaves: true },
        { parent: 7, at: 0.97, to: [10, -8], bend: 2, th: [1, 1], flower: { R: 15, open: 0.8, pal: 'blush' } },
        { parent: 7, at: 0.9, to: [-9, -6], bend: -1, th: [1, 1], bud: { len: 10 } },
      ],
    },
    center: {
      amp: 2.0,
      leafSize: [13, 18],
      branches: [
        { parent: null, to: [4, -212], bend: 8, th: [2, 2], leaves: true },
        { parent: 0, at: 0.9, to: [-15, -6], bend: -2, th: [1, 1], flower: { R: 18, open: 0.7, pal: 'stargazer' } },
        { parent: 0, at: 0.96, to: [14, -9], bend: 2, th: [1, 1], flower: { R: 16, open: 0.6, pal: 'white' } },
        { parent: 0, at: 1, to: [0, -12], bend: 1, th: [1, 1], bud: { len: 12 } },
        { parent: null, to: [-34, -150], bend: -8, th: [2, 2], leaves: true },
        { parent: 4, at: 0.97, to: [-11, -8], bend: -2, th: [1, 1], flower: { R: 15, open: 0.75, pal: 'blush' } },
        { parent: null, to: [30, -125], bend: 6, th: [2, 2], leaves: true },
        { parent: 6, at: 0.97, to: [10, -7], bend: 2, th: [1, 1], flower: { R: 14, open: 0.6, pal: 'stargazer' } },
        { parent: 6, at: 0.9, to: [-3, -10], bend: -1, th: [1, 1], bud: { len: 9 } },
      ],
    },
    far: {
      amp: 1.3,
      leafSize: [9, 12],
      branches: [
        { parent: null, to: [3, -140], bend: 4, th: [1, 1], leaves: true },
        { parent: 0, at: 0.95, to: [8, -6], bend: 1, th: [1, 1], flower: { R: 9, open: 0.7, pal: 'white' } },
        { parent: 0, at: 1, to: [0, -8], bend: 1, th: [1, 1], bud: { len: 7 } },
        { parent: null, to: [-16, -112], bend: -4, th: [1, 1], leaves: true },
        { parent: 3, at: 0.96, to: [-7, -5], bend: -1, th: [1, 1], flower: { R: 8, open: 0.6, pal: 'stargazer' } },
      ],
    },
  };

  const PAL_ORDER = ['stargazer', 'white', 'blush'];
  // Pochoirs d'épaisseur des tiges : indices dans [contour, sombre, moyen, clair]
  const STAMP = { 1: [2], 2: [3, 1], 3: [3, 2, 1], 4: [3, 2, 2, 1], 5: [3, 3, 2, 2, 1] };

  class LilyPlant {
    constructor(tpl, rootX, rootY, opt) {
      const rng = new Rng(CONFIG.seed + opt.seed * 7919);
      const m = opt.mirror ? -1 : 1;
      const scaleY = opt.scaleY || 1;
      this.fog = opt.fog;
      this.wind = new Wind(rng, tpl.amp);
      this.bark = ramp(PALETTE.twig, opt.fog);   // les tiges de lys sont vertes
      this.twig = ramp(PALETTE.twig, opt.fog);
      this.branches = [];
      this.leaves = [];
      this.flowers = [];

      // Géométrie en espace local (racine en 0,0), courbes de Bézier quadratiques.
      tpl.branches.forEach((bd) => {
        let sx = 0, sy = 0, s0 = 0;
        if (bd.parent != null) {
          const p = this.branches[bd.parent].local;
          const q = p[Math.round(bd.at * (p.length - 1))];
          sx = q.x; sy = q.y; s0 = q.s;
        }
        const short = bd.parent != null;
        const k = short ? LAYOUT.fs : 1;
        const ex = sx + bd.to[0] * k + (short ? rng.float(-1, 1) : rng.float(-3, 3));
        const ey = sy + bd.to[1] * (short ? LAYOUT.fs : scaleY * LAYOUT.vs) + (short ? rng.float(-1, 1) : rng.float(-4, 4) * LAYOUT.vs);
        const len = Math.hypot(ex - sx, ey - sy);
        const nx = -(ey - sy) / len, ny = (ex - sx) / len;
        const bend = bd.bend * rng.float(0.8, 1.2);
        const cx = (sx + ex) / 2 + nx * bend, cy = (sy + ey) / 2 + ny * bend;
        const N = Math.ceil(len * 1.6);
        const local = [];
        let arc = 0, px = sx, py = sy;
        for (let i = 0; i <= N; i++) {
          const t = i / N, it = 1 - t;
          const x = it * it * sx + 2 * it * t * cx + t * t * ex;
          const y = it * it * sy + 2 * it * t * cy + t * t * ey;
          arc += Math.hypot(x - px, y - py); px = x; py = y;
          local.push({ x, y, s: s0 + arc });
        }
        this.branches.push({ def: bd, local });
      });

      // Passage en coordonnées écran, hauteur relative s normalisée.
      const maxS = Math.max(...this.branches.map((b) => b.local[b.local.length - 1].s));
      const pals = (k) => PAL_ORDER[(PAL_ORDER.indexOf(k) + opt.seed) % PAL_ORDER.length];
      this.branches.forEach((b, bi) => {
        const n = b.local.length - 1;
        b.pts = b.local.map((q, i) => ({
          x: rootX + q.x * m,
          y: rootY + q.y,
          s: q.s / maxS,
          th: Math.max(1, Math.round(lerp(b.def.th[0], b.def.th[1], i / n))),
          twig: true,
        }));

        const tangent = (i) => {
          const a = b.pts[Math.max(0, i - 3)], c = b.pts[Math.min(n, i + 3)];
          const l = Math.hypot(c.x - a.x, c.y - a.y) || 1;
          return [(c.x - a.x) / l, (c.y - a.y) / l];
        };

        // Fleur ou bouton au bout du pédoncule, tournés dans son sens.
        const tip = b.pts[n];
        const [tx, ty] = tangent(n);
        const facing = clamp(Math.atan2(tx, -ty) * 1.15, -1.9, 1.9);
        const seed = opt.seed * 131 + bi * 17 + 3;
        if (b.def.flower) {
          const fd = b.def.flower;
          this.flowers.push({
            p: new LilyFlower({ seed, size: fd.R * LAYOUT.fs * rng.float(0.92, 1.08), facing, open: clamp(fd.open + rng.float(-0.08, 0.08), 0.35, 0.95), palette: pals(fd.pal), fog: opt.fog }),
            x: tip.x, y: tip.y, s: tip.s,
          });
        } else if (b.def.bud) {
          this.flowers.push({
            p: new LilyBud({ seed, length: b.def.bud.len * LAYOUT.fs * rng.float(0.9, 1.1), facing: facing * 0.7, palette: pals('white'), fog: opt.fog }),
            x: tip.x, y: tip.y, s: tip.s,
          });
        }

        // Feuilles alternes, étroites, qui montent le long de la tige.
        if (b.def.leaves) {
          let sideSign = rng.chance(0.5) ? 1 : -1;
          for (let u = rng.float(0.06, 0.1); u < 0.72; u += rng.float(0.085, 0.12)) {
            const i = Math.round(u * n);
            const pt = b.pts[i];
            const [gx, gy] = tangent(i);
            const base = Math.atan2(gy, gx);
            sideSign = -sideSign;
            const ang = base + sideSign * rng.float(0.35, 0.7) * lerp(1.5, 1, u);
            const length = rng.float(tpl.leafSize[0], tpl.leafSize[1]) * lerp(1.1, 0.7, u) * LAYOUT.fs;
            const width = rng.float(3, 4.2) * (tpl.leafSize[0] < 10 ? 0.75 : 1);
            const bend = sideSign * rng.float(0.5, 2.5);
            const lseed = rng.int(1, 1e9);
            this.leaves.push({
              frames: [0, 0.1].map((dd) => new LilyLeaf({ seed: lseed, length, width, angle: ang + dd, bend, fog: opt.fog }).sprite),
              x: pt.x, y: pt.y, s: pt.s,
              behind: rng.chance(0.4),
            });
          }
        }
      });
    }

    /** Position X entière d'une ligne de fleur (cisaillement = flexion). */
    rowX(P, row, t) {
      const sp = P.p.sprite;
      const h = clamp((sp.ay - row) / P.p.length, 0, 1.2);
      return Math.round(P.x + this.wind.sway(P.s + 0.3 * h, t)) - sp.ax;
    }

    /** Position écran d'un pixel du sprite d'une fleur à l'instant t. */
    pixelWorld(P, x, y, t) {
      return [this.rowX(P, y, t) + x, Math.round(P.y) - P.p.sprite.ay + y];
    }

    draw(frame, t) {
      for (const l of this.leaves) if (l.behind) this.drawLeaf(frame, l, t);
      for (const b of this.branches) this.drawStem(frame, b, t);
      for (const l of this.leaves) if (!l.behind) this.drawLeaf(frame, l, t);
      for (const P of this.flowers) this.drawFlower(frame, P, t);
    }

    drawLeaf(frame, l, t) {
      const sp = l.frames[this.wind.phase(l.s, t) > 0.45 ? 1 : 0];
      frame.blit(sp, Math.round(l.x + this.wind.sway(l.s, t)) - sp.ax, Math.round(l.y) - sp.ay);
    }

    drawStem(frame, b, t) {
      let lx = null, ly = null;
      for (let i = 0; i < b.pts.length; i++) {
        const p = b.pts[i];
        const x = Math.round(p.x + this.wind.sway(p.s, t)), y = Math.round(p.y);
        if (x === lx && y === ly) continue;
        const cols = p.twig ? this.twig : this.bark;
        if (lx !== null) {
          const steps = Math.max(Math.abs(x - lx), Math.abs(y - ly));
          const horiz = Math.abs(x - lx) > Math.abs(y - ly);
          for (let k = 1; k <= steps; k++) {
            this.stamp(frame, Math.round(lerp(lx, x, k / steps)), Math.round(lerp(ly, y, k / steps)), p.th, horiz, cols);
          }
        } else {
          this.stamp(frame, x, y, p.th, false, cols);
        }
        lx = x; ly = y;
      }
    }

    stamp(frame, x, y, th, horiz, cols) {
      const set = STAMP[Math.min(5, th)];
      const o = (set.length - 1) >> 1;
      for (let i = 0; i < set.length; i++) {
        if (horiz) frame.plot(x, y - o + i, cols[set[i]]);
        else frame.plot(x - o + i, y, cols[set[i]]);
      }
    }

    drawFlower(frame, P, t) {
      const sp = P.p.sprite;
      const top = Math.round(P.y) - sp.ay;
      const rows = new Int32Array(sp.h);
      for (let r = 0; r < sp.h; r++) {
        rows[r] = this.rowX(P, r, t);
        frame.blitRow(sp, r, rows[r], top + r);
      }
      // scintillement très discret de quelques pétales éclairés
      for (const s of P.p.sparkles) {
        const a = 0.45 * Math.pow(Math.max(0, Math.sin((TAU * s.n * t) / T + s.ph)), 4);
        frame.blend(rows[s.y] + s.x, top + s.y, SPARKLE_RGB, a);
      }
    }
  }
  const SPARKLE_RGB = hexRgb('#F4ECFF');

  // ===================================================================
  // Feuillage au sol (premier plan)
  // ===================================================================
  class GroundCover {
    constructor(W, H) {
      const rng = new Rng(CONFIG.seed + 555);
      this.wind = new Wind(rng, 1.4);
      this.leaves = [];
      const rows = [
        { fog: 0.3, dy: [-14, -6], len: [13, 17], step: [12, 18], spread: 0.9 },
        { fog: 0.14, dy: [-4, 2], len: [15, 20], step: [10, 15], spread: 1.0 },
        { fog: 0, dy: [5, 10], len: [17, 23], step: [11, 16], spread: 1.1 },
      ];
      for (const row of rows) {
        for (let x = rng.float(-8, 0); x < W + 8; x += rng.float(row.step[0], row.step[1])) {
          const length = rng.float(row.len[0], row.len[1]) * LAYOUT.fs;
          const angle = -Math.PI / 2 + rng.float(-row.spread, row.spread);
          const seed = rng.int(1, 1e9);
          this.leaves.push({
            frames: [0, 0.1].map((d) => new LilyLeaf({ seed, length: length * 1.2, width: 4.5, angle: angle + d, bend: (angle + Math.PI / 2) * 4, fog: row.fog }).sprite),
            x: Math.round(x), y: H + rng.int(row.dy[0], row.dy[1]), s: rng.float(0.4, 0.7),
          });
        }
      }
    }
    draw(frame, t) {
      for (const l of this.leaves) {
        const sp = l.frames[this.wind.phase(l.s, t) > 0.5 ? 1 : 0];
        frame.blit(sp, Math.round(l.x + this.wind.sway(l.s, t)) - sp.ax, l.y - sp.ay);
      }
    }
  }

  // ===================================================================
  // Arrière-plan statique : ciel tramé, lune, haie lointaine
  // ===================================================================
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  function buildBackground(W, H, moon) {
    const rng = new Rng(CONFIG.seed + 77);
    const bg = new Sprite(W, H);
    const sky = ramp(PALETTE.sky);
    const ridgeY = (x) => Math.round(H * 0.79 + 5 * Math.sin(x * 0.045 + 1.3) + 3 * Math.sin(x * 0.11 + 0.4) + 1.5 * Math.sin(x * 0.29));

    // Dégradé du ciel quantifié par tramage ordonné (Bayer 4×4).
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = 0.06 + 0.95 * Math.pow(y / H, 1.8);
        const gx = (x - W * 0.5) / (W * 0.9), gy = (y - H * 0.6) / (H * 0.4);
        v += 0.18 * Math.exp(-(gx * gx + gy * gy) * 2.2);               // lueur rosée au-dessus des fleurs
        const dm = Math.hypot(x - moon.x, y - moon.y);
        v += 0.26 * Math.exp(-(dm * dm) / (2 * 22 * 22));              // halo de la lune
        const f = clamp(v, 0, 1) * (sky.length - 1);
        const i0 = Math.floor(f);
        const th = (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
        bg.px[y * W + x] = sky[clamp(i0 + (f - i0 > th ? 1 : 0), 0, sky.length - 1)];
      }
    }

    // Pleine lune nacrée, ombrée vers le bas-droite, quelques mers tramées.
    const mc = ramp(PALETTE.moon);
    const R = 9;
    for (let dy = -R - 1; dy <= R + 1; dy++) {
      for (let dx = -R - 1; dx <= R + 1; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > R + 0.3) continue;
        const shade = (dx + dy) / (R * 1.4);  // 0 au centre, positif vers le bas-droite
        let i = d > R - 0.8 ? 3 : shade > 0.45 ? 2 : shade > 0.05 ? 1 : 0;
        const mare = Math.hypot(dx + 2, dy + 1) < 3 || Math.hypot(dx - 3, dy - 3) < 2.2 || Math.hypot(dx - 2, dy + 4) < 1.6;
        if (mare && i < 3) i += 1;
        bg.set(moon.x + dx, moon.y + dy, mc[i]);
      }
    }

    // Bokeh : quelques disques de lumière flous, très légers.
    const bf = new Frame(W, H, bg.px);
    const bokehCols = [hexRgb(PALETTE.rose[0]), hexRgb('#b8a0e3'), hexRgb(PALETTE.rose[1])];
    for (let i = 0; i < Math.max(5, Math.round(W / 34)); i++) {
      const cx = rng.float(0, W), cy = rng.float(H * 0.3, H * 0.78), r = rng.float(3, 7);
      const col = rng.pick(bokehCols), a = rng.float(0.05, 0.09);
      for (let dy = -Math.ceil(r); dy <= r; dy++) {
        for (let dx = -Math.ceil(r); dx <= r; dx++) {
          const d = Math.hypot(dx, dy);
          if (d <= r) bf.blend(Math.round(cx + dx), Math.round(cy + dy), col, d > r - 1 ? a * 1.6 : a);
        }
      }
    }

    // Massif de lys lointain, très voilé.
    const hedge = ramp(PALETTE.hedge);
    for (let x = 0; x < W; x++) {
      const r = ridgeY(x);
      for (let y = r; y < H; y++) {
        const k = y - r;
        bg.px[y * W + x] = k < 2 && (BAYER4[(y & 3) * 4 + (x & 3)] & 1) ? hedge[2] : y > H * 0.93 ? hedge[0] : hedge[1];
      }
    }
    const farLeaves = [];
    for (let x = rng.float(2, 8); x < W; x += rng.float(10, 17)) {
      const base = ridgeY(Math.round(x)) + rng.int(2, 6);
      for (let k = 0; k < 2; k++) {
        const lf = new LilyLeaf({ seed: rng.int(1, 1e9), length: rng.float(8, 12), width: 2.5, angle: -Math.PI / 2 + rng.float(-1.0, 1.0), fog: 0.72 }).sprite;
        farLeaves.push([lf, Math.round(x + rng.float(-5, 5)), base + rng.int(0, 4)]);
      }
      const p = new LilyFlower({
        seed: rng.int(1, 1e9), size: rng.float(4.5, 6), facing: rng.float(-0.7, 0.7),
        open: rng.float(0.5, 0.85), palette: rng.pick(PAL_ORDER), fog: 0.62,
      }).sprite;
      farLeaves.push([p, Math.round(x), base - rng.int(4, 8)]);
    }
    const f = new Frame(W, H, bg.px);
    for (const [sp, x, y] of farLeaves) f.blit(sp, x - sp.ax, y - sp.ay);
    return bg;
  }

  // ===================================================================
  // Étoiles (scintillement lent)
  // ===================================================================
  class Sky {
    constructor(W, H, moon) {
      const rng = new Rng(CONFIG.seed + 99);
      const colors = ['#e9e2ff', '#cdbff2', '#b8a0e3', '#ffffff'].map(hexRgb);
      this.stars = [];
      // Une constellation en forme de cœur ; une onde de lumière en fait
      // le tour une fois par boucle.
      // en haut à droite, pour laisser le centre aux feux d'artifice
      this.heart = { x: Math.round(W - 38), y: Math.round(Math.min(H * 0.075, 32)) };
      const k = 1.0, N = 18;
      this.heartStars = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU;
        const hx = 16 * Math.pow(Math.sin(a), 3);
        const hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
        this.heartStars.push({
          x: this.heart.x + Math.round(hx * k), y: this.heart.y + Math.round(hy * k),
          ph: -(i / N) * TAU, cross: i === 3 || i === 17 || i === 10,
        });
      }
      this.heartRgb = hexRgb('#ffe6f0');
      const n = Math.round((W * H) / 2400);
      for (let i = 0; i < n; i++) {
        const x = rng.int(1, W - 2), y = rng.int(2, Math.round(H * 0.6));
        if (Math.hypot(x - moon.x, y - moon.y) < 24) continue;
        if (Math.hypot(x - this.heart.x, y - this.heart.y) < 34) continue;
        this.stars.push({
          x, y,
          base: rng.float(0.25, 0.75) * (1 - (y / H) * 0.6),
          n: rng.int(1, 5), ph: rng.float(0, TAU),
          cross: rng.chance(0.12),
          rgb: rng.pick(colors),
        });
      }
    }
    draw(frame, t) {
      // tracé pointillé très discret reliant les étoiles du cœur
      const hs = this.heartStars;
      for (let i = 0; i < hs.length; i++) {
        const a = hs[i], b = hs[(i + 1) % hs.length];
        const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        for (let k = 1; k < steps; k++) {
          if (k % 2) continue;
          frame.blend(Math.round(lerp(a.x, b.x, k / steps)), Math.round(lerp(a.y, b.y, k / steps)), this.heartRgb, 0.1);
        }
      }
      for (const s of hs) {
        const wave = Math.pow(0.5 + 0.5 * Math.cos((TAU * t) / T + s.ph), 6);
        const a = 0.42 + 0.5 * wave;
        frame.blend(s.x, s.y, this.heartRgb, a);
        if (s.cross || wave > 0.6) {
          const b = a * (s.cross ? 0.4 : 0.22);
          frame.blend(s.x - 1, s.y, this.heartRgb, b); frame.blend(s.x + 1, s.y, this.heartRgb, b);
          frame.blend(s.x, s.y - 1, this.heartRgb, b); frame.blend(s.x, s.y + 1, this.heartRgb, b);
        }
      }
      for (const s of this.stars) {
        const a = s.base * (0.6 + 0.4 * Math.sin((TAU * s.n * t) / T + s.ph));
        frame.blend(s.x, s.y, s.rgb, a);
        if (s.cross) {
          const b = a * 0.32;
          frame.blend(s.x - 1, s.y, s.rgb, b); frame.blend(s.x + 1, s.y, s.rgb, b);
          frame.blend(s.x, s.y - 1, s.rgb, b); frame.blend(s.x, s.y + 1, s.rgb, b);
        }
      }
    }
  }

  // ===================================================================
  // Lucioles : quelques points lumineux qui dérivent lentement
  // ===================================================================
  class Motes {
    constructor(W, H) {
      const rng = new Rng(CONFIG.seed + 1234);
      this.core = hexRgb('#fff1e6');
      this.halo = hexRgb('#ffb3d1');
      this.list = [];
      const n = W > 320 ? 10 : 6;
      for (let i = 0; i < n; i++) {
        this.list.push({
          cx: rng.float(W * 0.12, W * 0.88), cy: rng.float(H * 0.42, H * 0.82),
          ax: rng.float(12, 26), ay: rng.float(8, 18),
          n1: rng.int(1, 2), n2: rng.int(1, 3), n3: rng.int(2, 4),
          p1: rng.float(0, TAU), p2: rng.float(0, TAU), p3: rng.float(0, TAU),
        });
      }
    }
    draw(frame, t) {
      for (const m of this.list) {
        const x = Math.round(m.cx + m.ax * Math.sin((TAU * m.n1 * t) / T + m.p1));
        const y = Math.round(m.cy + m.ay * Math.sin((TAU * m.n2 * t) / T + m.p2));
        const g = Math.pow(0.5 + 0.5 * Math.sin((TAU * m.n3 * t) / T + m.p3), 2);
        frame.blend(x, y, this.core, 0.2 + 0.7 * g);
        const h = 0.3 * g, h2 = 0.1 * g;
        frame.blend(x - 1, y, this.halo, h); frame.blend(x + 1, y, this.halo, h);
        frame.blend(x, y - 1, this.halo, h); frame.blend(x, y + 1, this.halo, h);
        frame.blend(x - 1, y - 1, this.halo, h2); frame.blend(x + 1, y - 1, this.halo, h2);
        frame.blend(x - 1, y + 1, this.halo, h2); frame.blend(x + 1, y + 1, this.halo, h2);
        frame.blend(x - 2, y, this.halo, h2); frame.blend(x + 2, y, this.halo, h2);
        frame.blend(x, y - 2, this.halo, h2); frame.blend(x, y + 2, this.halo, h2);
      }
    }
  }

  // ===================================================================
  // Pétales qui se détachent (rares, calendrier fixe dans la boucle)
  // ===================================================================
  class PetalSystem {
    constructor(shrubs, W, H) {
      const rng = new Rng(CONFIG.seed + 4242);
      const sources = [];
      for (const sh of shrubs) for (const P of sh.flowers) if (P.p.front.length) sources.push([sh, P]);
      const colors = PALETTE.petal.map(hexRgb);
      this.petals = [];
      const n = CONFIG.petalsPerLoop;
      for (let i = 0; i < n && sources.length; i++) {
        const t0 = ((i + rng.float(0.15, 0.85)) * T) / n;
        // une fleur éclairée et visible à l'écran au moment du départ
        let x0 = -1, y0 = 0;
        for (let k = 0; k < 40 && (x0 < 6 || x0 > W - 6); k++) {
          const [sh, P] = rng.pick(sources);
          const [fx, fy] = rng.pick(P.p.front);
          [x0, y0] = sh.pixelWorld(P, fx, fy, t0);
        }
        const pe = {
          t0, x0, y0,
          vy: rng.float(7, 10),
          drift: rng.float(-1.6, 2.2),
          amp: rng.float(3, 6), f: rng.float(0.7, 1.2), ph: rng.float(0, TAU),
          ground: H - rng.int(3, 9),
          c1: rng.chance(0.4) ? colors[3] : colors[2], c2: colors[rng.int(0, 1)],
        };
        // instant où le pétale touche le sol (calculé une fois)
        pe.land = T;
        for (let a = 0; a < T; a += 0.05) if (this.fall(pe, a) >= pe.ground) { pe.land = a; break; }
        pe.life = Math.min(T - 1, pe.land + 2.5);
        this.petals.push(pe);
      }
    }
    fall(pe, age) { return pe.y0 + pe.vy * (age - 0.9 * (1 - Math.exp(-age / 0.9))); }
    draw(frame, t) {
      for (const pe of this.petals) {
        const age = (((t - pe.t0) % T) + T) % T;
        if (age > pe.life) continue;
        const a = Math.min(age, pe.land);
        const x = Math.round(pe.x0 + pe.drift * a + pe.amp * (Math.sin(pe.f * a + pe.ph) - Math.sin(pe.ph)) * Math.min(1, a / 1.5));
        const y = Math.round(Math.min(pe.ground, this.fall(pe, a)));
        const alpha = age > pe.land ? 1 - (age - pe.land) / 2.5 : Math.min(1, age / 0.35);
        // petite rotation simulée : 1 px, 2 px horizontal, 1 px, 2 px vertical
        const shape = age > pe.land ? 1 : Math.floor(age * 2.4 + pe.ph) % 4;
        frame.blend(x, y, pe.c1, alpha * 0.95);
        if (shape === 1) frame.blend(x + 1, y, pe.c2, alpha * 0.85);
        if (shape === 3) frame.blend(x, y + 1, pe.c2, alpha * 0.85);
      }
    }
  }

  // ===================================================================
  // Feu d'artifice en cœur, au centre
  // ===================================================================
  /*
   * Une fusée rose monte de derrière les lys, puis éclate en étincelles
   * qui s'ouvrent jusqu'à dessiner un cœur, retombent doucement et
   * s'éteignent. Calendrier fixe dans la boucle (CONFIG.fireworkTimes).
   */
  class HeartFirework {
    /**
     * x, y1  : point d'éclatement
     * scale  : taille du cœur (demi-largeur = 16 × scale pixels)
     * delay  : décalage (s) par rapport à l'instant de lancement de la salve
     */
    constructor(H, { x, y1, scale, delay, seed }) {
      const rng = new Rng(CONFIG.seed + seed);
      this.cols = PALETTE.rose.map(hexRgb);
      this.white = hexRgb('#fff6fa');
      this.x = Math.round(x);
      this.y0 = Math.round(H * 0.7);                 // départ, caché dans les fleurs
      this.y1 = Math.round(y1);                      // point d'éclatement
      this.delay = delay;
      this.rise = 1.2;                               // durée de la montée (s)
      this.life = 4.6 + scale * 0.25;                // durée de l'éclat (s)
      this.sparks = [];
      // contour du cœur + un cœur intérieur plus petit et plus clairsemé ;
      // le nombre d'étincelles suit la taille pour garder un contour net
      const nOuter = Math.round(24 * scale), nInner = Math.round(11 * scale);
      // échantillonnage à longueur d'arc constante : pas d'amas dans le creux du cœur
      const curve = [];
      for (let i = 0, len = 0; i <= 400; i++) {
        const a = (i / 400) * TAU;
        const p = [16 * Math.pow(Math.sin(a), 3), -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) - 2.5];
        if (i) len += Math.hypot(p[0] - curve[i - 1][0], p[1] - curve[i - 1][1]);
        curve.push([p[0], p[1], len]);
      }
      const total = curve[400][2];
      const at = (d) => { let i = 0; while (i < 399 && curve[i + 1][2] < d) i++; return curve[i]; };
      for (const [n, k, ci] of [[nOuter, 1, 1], [nInner, 0.55, 2]]) {
        for (let i = 0; i < n; i++) {
          const [hx, hy] = at(((i + 0.5 + rng.float(-0.15, 0.15)) / n) * total);
          const j = k * scale * rng.float(0.96, 1.04);
          this.sparks.push({
            tx: hx * j,
            ty: hy * j,
            fall: rng.float(2.5, 6),                   // chute pendant l'extinction
            fade: rng.float(0.8, 1.15),                // chaque étincelle s'éteint à son rythme
            ph: rng.float(0, TAU),
            col: ci === 1 ? (rng.chance(0.7) ? 0 : 1) : 2,
            outer: ci === 1,
          });
        }
      }
    }

    draw(frame, t) {
      for (const start of CONFIG.fireworkTimes) {
        const age = (((t - start - this.delay) % T) + T) % T;
        if (age < this.rise) this.drawRocket(frame, age);
        else if (age < this.rise + this.life) this.drawBurst(frame, age - this.rise);
      }
    }

    rocketY(age) {
      const p = clamp(age / this.rise, 0, 1);
      return lerp(this.y0, this.y1, 1 - (1 - p) * (1 - p));
    }

    drawRocket(frame, age) {
      // tête claire + traînée qui s'estompe
      for (let k = 5; k >= 0; k--) {
        const a2 = age - k * 0.05;
        if (a2 < 0) continue;
        const x = this.x + Math.round(0.6 * Math.sin(a2 * 9));
        const y = Math.round(this.rocketY(a2));
        frame.blend(x, y, k === 0 ? this.white : this.cols[k < 3 ? 1 : 0], k === 0 ? 0.95 : 0.6 - k * 0.1);
      }
    }

    drawBurst(frame, age) {
      // lueur douce au moment de l'éclat (pas de flash)
      if (age < 0.6) {
        const g = 0.22 * (1 - age / 0.6);
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            const d = Math.hypot(dx, dy);
            if (d <= 3) frame.blend(this.x + dx, this.y1 + dy, this.cols[1], g * (1 - d / 3.5));
          }
        }
      }
      const open = 1 - Math.pow(1 - clamp(age / 1.0, 0, 1), 3);   // ouverture en douceur
      const drop = Math.max(0, age - 1.1);
      for (const s of this.sparks) {
        const fadeStart = 1.7 * s.fade, fadeEnd = this.life * s.fade;
        let a = age < fadeStart ? 1 : 1 - (age - fadeStart) / (fadeEnd - fadeStart);
        if (a <= 0) continue;
        a *= 0.8 + 0.2 * Math.sin(age * 7 + s.ph);                   // léger scintillement
        const fx = this.x + s.tx * open;
        const fy = this.y1 + s.ty * open + s.fall * drop * drop * 0.35;
        const x = Math.round(fx), y = Math.round(fy);
        frame.blend(x, y, age < 0.5 ? this.white : this.cols[s.col], a);
        // éclat en croix sur le contour tant que le cœur est bien formé
        if (s.outer && age > 0.7 && age < 2.4) {
          const c = a * 0.28 * (0.5 + 0.5 * Math.sin(age * 5 + s.ph));
          frame.blend(x - 1, y, this.cols[0], c); frame.blend(x + 1, y, this.cols[0], c);
          frame.blend(x, y - 1, this.cols[0], c); frame.blend(x, y + 1, this.cols[0], c);
        }
        // petite traînée vers le centre pendant l'ouverture, puis vers le haut en tombant
        const tx = age < 1.0 ? Math.round(this.x + s.tx * open * 0.82) : x;
        const ty = age < 1.0 ? Math.round(this.y1 + s.ty * open * 0.82) : y - 1;
        if (s.outer && (tx !== x || ty !== y)) frame.blend(tx, ty, this.cols[0], a * 0.35);
      }
    }
  }

  // ===================================================================
  // Pivoine (vue de face, pétales en coupe superposés)
  // ===================================================================
  /*
   * Quatre couronnes de pétales, de l'extérieur vers le cœur. Chaque
   * pétale est un petit disque ombré comme une coupe : bord extérieur
   * relevé et éclairé, creux tourné vers le centre plus sombre. Le cœur
   * est froissé de quelques plis sombres.
   */
  class Peony {
    constructor({ seed, r, palette }) {
      const rng = new Rng(seed);
      const c = ramp(PALETTE.peony[palette]);
      const S = Math.ceil(r * 2) + 7, o = S >> 1;
      const sp = new Sprite(S, S, o, o);
      const rings = [
        { n: 9, dist: 0.62, rad: 0.44, base: 3, rot: 0 },
        { n: 7, dist: 0.4, rad: 0.38, base: 4, rot: 0.4 },
        { n: 6, dist: 0.2, rad: 0.3, base: 5, rot: 0.9 },
        { n: 4, dist: 0.06, rad: 0.2, base: 6, rot: 0.2 },
      ];
      for (const ring of rings) {
        for (let i = 0; i < ring.n; i++) {
          const a = ring.rot + (i / ring.n) * TAU + rng.float(-0.2, 0.2);
          const ca = Math.cos(a), sa = Math.sin(a);
          const px = Math.round(ca * ring.dist * r), py = Math.round(sa * ring.dist * r * 0.88);
          const pr = ring.rad * r * rng.float(0.9, 1.12);
          const R = Math.ceil(pr) + 1;
          for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
              const d = Math.hypot(dx, dy * 1.1) / pr;
              if (d > 1) continue;
              const lit = (dx * LIGHT[0] + dy * LIGHT[1]) / pr;  // face tournée vers la lune
              const out = (dx * ca + dy * sa) / pr;               // bord relevé du pétale
              let idx = ring.base + Math.round(lit * 1.6 + out * 1.0);
              if (d > 0.8) idx -= 2;                             // pli sombre entre les pétales
              else if (out > 0.45 && lit > -0.2) idx += 1;       // bord du pétale qui accroche la lumière
              sp.set(o + px + dx, o + py + dy, c[clamp(idx, 1, 7)]);
            }
          }
        }
      }
      // plis froissés au cœur de la fleur
      for (let i = 0; i < Math.round(r * 0.6); i++) {
        const a = rng.float(0, TAU), d = rng.float(0.08, 0.34) * r;
        sp.set(o + Math.round(Math.cos(a) * d), o + Math.round(Math.sin(a) * d * 0.88), c[3]);
      }
      // contour de la fleur
      const src = sp.px.slice();
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          if (src[y * S + x]) continue;
          if ((x > 0 && src[y * S + x - 1]) || (x < S - 1 && src[y * S + x + 1]) ||
              (y > 0 && src[(y - 1) * S + x]) || (y < S - 1 && src[(y + 1) * S + x])) sp.px[y * S + x] = c[1];
        }
      }
      this.sprite = sp;
    }
  }

  // ===================================================================
  // Bouquet rose et blanc : lys, pivoines, gypsophile, papier, ruban
  // ===================================================================
  function stampSprite(dst, src, x, y) {
    for (let r = 0; r < src.h; r++) {
      for (let c = 0; c < src.w; c++) {
        const v = src.px[r * src.w + c];
        if (v) dst.set(x - src.ax + c, y - src.ay + r, v);
      }
    }
  }

  function buildBouquet(K = 1.3) {               // K : échelle de tout le bouquet
    const rng = new Rng(CONFIG.seed + 5150);
    const k = (v) => Math.round(v * K);
    const Wb = k(96), Hb = k(124), cx = Wb >> 1, tipY = k(120);
    const sp = new Sprite(Wb, Hb, cx, Hb >> 1);

    // 1. Papier rose du fond, ouvert en éventail, bord festonné.
    const back = ramp(PALETTE.wrapPink);
    const backTop = k(48), backHalf = k(43);
    for (let y = backTop; y <= tipY; y++) {
      const half = (backHalf * (tipY - y)) / (tipY - backTop);
      for (let x = 0; x < Wb; x++) {
        const dx = x - cx;
        if (Math.abs(dx) > half || y < backTop + 1.5 + 1.5 * Math.sin(x * 0.5)) continue;
        const u = dx / Math.max(1, half);
        const idx = u < -0.8 ? 4 : u > 0.75 ? 1 : (Math.floor((u + 1) * 4) % 2 ? 2 : 3);
        sp.set(x, y, back[idx]);
      }
    }

    // 2. Verdure tramée au fond du bouquet, pour qu'aucun trou ne laisse voir le ciel.
    const greens = ramp(PALETTE.leaf);
    for (let y = k(26); y <= k(70); y++) {
      for (let x = cx - k(32); x <= cx + k(32); x++) {
        const ex = (x - cx) / k(32), ey = (y - k(48)) / k(22);
        if (ex * ex + ey * ey > 1) continue;
        sp.set(x, y, greens[BAYER4[(y & 3) * 4 + (x & 3)] < 6 ? 3 : 2]);
      }
    }

    // 2b. Feuillage qui déborde du papier.
    const leaves = [
      [-33, 70, Math.PI + 0.55, 15], [-37, 57, Math.PI + 0.1, 14], [-26, 44, -Math.PI / 2 - 0.8, 13],
      [33, 70, 0.55, 15], [37, 57, -0.1, 14], [26, 44, -Math.PI / 2 + 0.8, 13],
    ];
    for (const [x, y, ang, len] of leaves) {
      stampSprite(sp, new LilyLeaf({ seed: rng.int(1, 1e9), length: k(len * 1.4), width: k(4), angle: ang, bend: Math.cos(ang) * 2, fog: 0 }).sprite, cx + k(x), k(y));
    }

    // 3. Lys roses et blancs, en couronne derrière les pivoines, et leurs boutons.
    const buds = [[-7, 30, 12, -0.25, 'white'], [8, 32, 11, 0.3, 'blush']];
    for (const [x, y, len, facing, pal] of buds) {
      stampSprite(sp, new LilyBud({ seed: rng.int(1, 1e9), length: k(len), facing, palette: pal, fog: 0 }).sprite, cx + k(x), k(y));
    }
    const lilies = [
      [-26, 60, 11, -1.15, 0.72, 'white'], [26, 60, 11, 1.15, 0.72, 'stargazer'],
      [-14, 48, 12, -0.55, 0.82, 'stargazer'], [14, 47, 12, 0.55, 0.82, 'white'],
      [0, 44, 12, 0, 0.9, 'blush'],
    ];
    for (const [x, y, R, facing, open, pal] of lilies) {
      stampSprite(sp, new LilyFlower({ seed: rng.int(1, 1e9), size: k(R), facing, open, palette: pal, fog: 0, outline: false }).sprite, cx + k(x), k(y));
    }

    // 4. Pivoines roses et blanches, généreuses, au premier plan.
    const peonies = [
      [-22, 70, 9, 'white'], [22, 69, 9, 'pink'],
      [-11, 63, 11, 'pink'], [12, 62, 10.5, 'white'],
      [0, 73, 10, 'pink'],
    ];
    for (const [x, y, r, pal] of peonies) {
      stampSprite(sp, new Peony({ seed: rng.int(1, 1e9), r: r * K, palette: pal }).sprite, cx + k(x), k(y));
    }

    // 5. Gypsophile : de minuscules fleurs blanches qui allègent le contour.
    const gyps = ramp(['#ffffff', '#e7dbe3']);
    for (let i = 0; i < 34; i++) {
      const ang = rng.float(Math.PI * 1.02, Math.PI * 1.98), d = rng.float(0.8, 1.06);
      const x = Math.round(cx + Math.cos(ang) * k(42) * d), y = Math.round(k(62) + Math.sin(ang) * k(34) * d);
      sp.set(x, y, gyps[0]);
      if (rng.chance(0.6)) sp.set(x + 1, y + 1, gyps[1]);
    }

    // 6. Papier blanc devant, rabat en biais, plis qui convergent vers la pointe.
    const front = ramp(PALETTE.wrapWhite);
    const fTop = k(78), fHalf = k(37);
    const frontTop = (x) => Math.round(fTop - 4 + ((x - cx + fHalf) / (2 * fHalf)) * 8);
    for (let y = fTop - 6; y <= tipY; y++) {
      const half = (fHalf * (tipY - y)) / (tipY - fTop + 4);
      for (let x = 0; x < Wb; x++) {
        const dx = x - cx;
        const top = frontTop(x);
        if (y < top || Math.abs(dx) > half) continue;
        const u = dx / Math.max(1, half);
        let idx = u < -0.82 ? 4 : u > 0.72 ? 1 : (Math.floor((u + 1) * 3.5) % 2 ? 2 : 3);
        if (y <= top + 1) idx = y === top ? 4 : 3;  // rabat replié, éclairé
        sp.set(x, y, front[idx]);
      }
    }

    // 7. Ruban rose noué en nœud.
    const rb = ramp(PALETTE.ribbon);
    const by = k(98);
    for (let y = by - 1; y <= by + 1; y++) {
      const half = (fHalf * (tipY - y)) / (tipY - fTop + 4);
      for (let x = Math.ceil(cx - half); x <= cx + half; x++) sp.set(x, y, rb[y === by - 1 ? 3 : 2]);
    }
    const lx = k(8), ly = k(4.5);
    for (const side of [-1, 1]) {
      for (let dy = -ly; dy <= ly; dy++) {
        for (let dx = -lx; dx <= lx; dx++) {
          if ((dx * dx) / (lx * lx) + (dy * dy) / (ly * ly) > 1) continue;
          // boucle en goutte : creux sombre décalé vers l'extérieur, reflet en haut
          const hx = dx - side * lx * 0.25;
          const inner = (hx * hx) / (lx * lx * 0.12) + (dy * dy) / (ly * ly * 0.12) < 1;
          sp.set(cx + side * lx + dx, by - 1 + dy, rb[inner ? 2 : dy < -1 ? 4 : dy > 1 ? 2 : 3]);
        }
      }
      for (let i = 0; i < k(13); i++) {  // pans du ruban
        const x = Math.round(cx + side * (2 + i * 0.45)), y = by + 2 + i;
        sp.set(x, y, rb[2]); sp.set(x + side, y, rb[side < 0 ? 3 : 1]);
      }
    }
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sp.set(cx + dx, by - 1 + dy, rb[dy < 0 && dx < 0 ? 4 : 2]);

    // 8. Contour sombre tout autour : le bouquet se détache du ciel.
    const line = ramp([PALETTE.bouquetLine])[0];
    const src = sp.px.slice();
    for (let y = 0; y < Hb; y++) {
      for (let x = 0; x < Wb; x++) {
        if (src[y * Wb + x]) continue;
        if ((x > 0 && src[y * Wb + x - 1]) || (x < Wb - 1 && src[y * Wb + x + 1]) ||
            (y > 0 && src[(y - 1) * Wb + x]) || (y < Hb - 1 && src[(y + 1) * Wb + x])) sp.px[y * Wb + x] = line;
      }
    }
    return sp.crop();
  }

  /*
   * Le bouquet apparaît après les retombées de chaque salve : il éclot du
   * centre vers les bords (fondu tramé, pixel par pixel), flotte doucement
   * dans une lueur rose, scintille, puis se dissout avant la salve suivante.
   */
  class BouquetVision {
    constructor(W, H) {
      const rng = new Rng(CONFIG.seed + 5151);
      this.sprite = buildBouquet(1.3 * clamp(H / 330, 0.7, 1));
      this.x = Math.round(W / 2);
      this.y = Math.round(Math.max(H * 0.24, this.sprite.h / 2 + 3));
      this.glow = hexRgb(PALETTE.rose[0]);
      this.spark = hexRgb('#fff6fa');
      // ordre d'apparition : du cœur du bouquet vers l'extérieur, tramé
      const sp = this.sprite;
      this.order = new Float32Array(sp.w * sp.h);
      const R = Math.hypot(sp.w / 2, sp.h / 2);
      for (let y = 0; y < sp.h; y++) {
        for (let x = 0; x < sp.w; x++) {
          const d = Math.hypot(x - sp.ax, y - (sp.ay - 4)) / R;
          this.order[y * sp.w + x] = 0.55 * d + 0.45 * ((BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16);
        }
      }
      this.gw = Math.round(sp.w * 0.58); this.gh = Math.round(sp.h * 0.5);
      this.sparkles = [];
      for (let i = 0; i < 8; i++) {
        const a = rng.float(0, TAU), d = rng.float(0.8, 1.05);
        this.sparkles.push({ dx: Math.round(Math.cos(a) * this.gw * d), dy: Math.round(Math.sin(a) * this.gh * d) - 8, n: rng.int(5, 9), ph: rng.float(0, TAU) });
      }
      // calendrier, relatif à chaque salve (s)
      this.tIn = 7.0; this.tFull = 8.8; this.tOut = 14.0; this.tGone = 15.4;
    }

    draw(frame, t) {
      for (const start of CONFIG.fireworkTimes) {
        const age = (((t - start) % T) + T) % T;
        if (age <= this.tIn || age >= this.tGone) continue;
        const p = age < this.tFull ? (age - this.tIn) / (this.tFull - this.tIn)
          : age < this.tOut ? 1 : 1 - (age - this.tOut) / (this.tGone - this.tOut);
        const rise = Math.round((1 - smooth((age - this.tIn) / (this.tFull - this.tIn))) * 8);
        const bob = Math.round(Math.sin((TAU * 8 * t) / T) * 1.2);
        const cx = this.x, cy = this.y + rise + bob;

        // halo rose en trois paliers
        const gw = this.gw, gh = this.gh;
        for (let dy = -gh; dy <= gh; dy++) {
          for (let dx = -gw; dx <= gw; dx++) {
            const d = Math.hypot(dx / gw, dy / gh);
            if (d > 1) continue;
            frame.blend(cx + dx, cy + dy, this.glow, p * (d < 0.45 ? 0.13 : d < 0.75 ? 0.08 : 0.04));
          }
        }

        // éclosion tramée
        const sp = this.sprite, x0 = cx - sp.ax, y0 = cy - sp.ay;
        for (let r = 0; r < sp.h; r++) {
          const y = y0 + r;
          if (y < 0 || y >= frame.h) continue;
          for (let c = 0; c < sp.w; c++) {
            const v = sp.px[r * sp.w + c];
            const x = x0 + c;
            if (v && x >= 0 && x < frame.w && this.order[r * sp.w + c] < p) frame.px[y * frame.w + x] = v;
          }
        }

        // scintillements autour du bouquet
        for (const s of this.sparkles) {
          const a = p * 0.9 * Math.pow(Math.max(0, Math.sin((TAU * s.n * t) / T + s.ph)), 3);
          const x = cx + s.dx, y = cy + s.dy;
          frame.blend(x, y, this.spark, a);
          frame.blend(x - 1, y, this.spark, a * 0.4); frame.blend(x + 1, y, this.spark, a * 0.4);
          frame.blend(x, y - 1, this.spark, a * 0.4); frame.blend(x, y + 1, this.spark, a * 0.4);
        }
      }
    }
  }

  // ===================================================================
  // Petits cœurs qui s'élèvent doucement des fleurs (rares)
  // ===================================================================
  const HEART_MASK = [
    '.X.X.',
    'XXXXX',
    'XXXXX',
    '.XXX.',
    '..X..',
  ];
  class FloatingHearts {
    constructor(shrubs, W, H) {
      const rng = new Rng(CONFIG.seed + 777);
      const sources = [];
      for (const sh of shrubs) for (const P of sh.flowers) if (P.p.front.length) sources.push([sh, P]);
      this.cols = PALETTE.rose.map(hexRgb);
      this.list = [];
      const n = CONFIG.heartsPerLoop;
      for (let i = 0; i < n && sources.length; i++) {
        const t0 = ((i + rng.float(0.3, 0.7)) * T) / n;
        let x0 = -1, y0 = 0;
        for (let k = 0; k < 40 && (x0 < 12 || x0 > W - 12); k++) {
          const [sh, P] = rng.pick(sources);
          const [fx, fy] = rng.pick(P.p.front);
          [x0, y0] = sh.pixelWorld(P, fx, fy, t0);
        }
        this.list.push({ t0, x0, y0: y0 - 3, life: rng.float(9, 12), vy: rng.float(3.2, 4.4), amp: rng.float(2, 4), ph: rng.float(0, TAU) });
      }
    }
    draw(frame, t) {
      for (const h of this.list) {
        const age = (((t - h.t0) % T) + T) % T;
        if (age > h.life) continue;
        const x = Math.round(h.x0 + h.amp * (Math.sin(age * 0.8 + h.ph) - Math.sin(h.ph))) - 2;
        const y = Math.round(h.y0 - h.vy * age) - 2;
        const a = 0.75 * Math.pow(Math.sin((Math.PI * age) / h.life), 1.5);
        for (let r = 0; r < 5; r++) {
          for (let c = 0; c < 5; c++) {
            if (HEART_MASK[r][c] !== 'X') continue;
            // reflet en haut à gauche, ombre en bas à droite
            const col = r === 1 && c <= 1 ? this.cols[2] : (r >= 2 && c >= 3) || r === 4 ? this.cols[0] : this.cols[1];
            frame.blend(x + c, y + r, col, a);
          }
        }
      }
    }
  }

  // ===================================================================
  // Composition
  // ===================================================================
  function buildLayout(W, H) {
    const rng = new Rng(CONFIG.seed + 9);
    const list = [];
    // plan lointain
    const farCount = Math.max(2, Math.round(W / 95));
    for (let i = 0; i < farCount; i++) {
      const x = ((i + 0.5) * W) / farCount + rng.float(-8, 8);
      list.push(new LilyPlant(TEMPLATES.far, x, H + 4, { seed: 300 + i, fog: 0.42, mirror: i % 2 === 1, scaleY: rng.float(0.85, 1.1) }));
    }
    // plan médian : les lys qui montent vers le centre
    const midCount = W < 330 ? 1 : Math.max(1, Math.round((W - 60) / 130));
    for (let i = 0; i < midCount; i++) {
      const x = midCount === 1 ? W * 0.5 - 4 : lerp(95, W - 95, i / (midCount - 1));
      // en paysage, on alterne avec des massifs plus fournis
      const bushy = midCount > 1 && i % 2 === 1;
      list.push(new LilyPlant(bushy ? TEMPLATES.edge : TEMPLATES.center, bushy ? x - 20 : x, H + 6, {
        seed: 200 + i, fog: bushy ? 0.1 : 0.16, mirror: i % 4 === 3, scaleY: bushy ? 0.95 : 1,
      }));
    }
    // premier plan : deux massifs qui entrent par les bords
    list.push(new LilyPlant(TEMPLATES.edge, -3, H + 6, { seed: 101, fog: 0, mirror: false, scaleY: 1 }));
    list.push(new LilyPlant(TEMPLATES.edge, W + 3, H + 6, { seed: 102, fog: 0, mirror: true, scaleY: 1.1 }));
    return list;
  }

  class Scene {
    constructor(W, H) {
      this.W = W; this.H = H;
      LAYOUT.vs = clamp(H / 422, 0.5, 1.15);
      LAYOUT.fs = clamp(0.55 + 0.45 * LAYOUT.vs, 0.8, 1);
      const landscape = W > H * 1.2;
      const moon = { x: Math.round(Math.max(26, W * 0.22)), y: Math.round(Math.min(H * 0.1, 46)) };
      this.background = buildBackground(W, H, moon);
      this.sky = new Sky(W, H, moon);
      this.shrubs = buildLayout(W, H);
      this.ground = new GroundCover(W, H);
      this.petals = new PetalSystem(this.shrubs.filter((s) => s.fog < 0.3), W, H);
      this.motes = new Motes(W, H);
      this.hearts = new FloatingHearts(this.shrubs.filter((s) => s.fog < 0.3), W, H);
      // Salve : un grand cœur au centre, deux plus petits sur les côtés,
      // lancés presque en même temps.
      // (en paysage, les petits cœurs montent plus haut pour rester au-dessus des lys)
      const big = Math.min(4.2, (W * 0.36) / 16, (H * 0.27) / 14.5);
      const side = big * 0.55;
      const off = Math.max(W * 0.3, 58);
      this.fireworks = [
        new HeartFirework(H, { x: W / 2, y1: H * 0.29, scale: big, delay: 0, seed: 2024 }),
        new HeartFirework(H, { x: W / 2 - off, y1: H * (landscape ? 0.33 : 0.45), scale: side, delay: 0.35, seed: 2025 }),
        new HeartFirework(H, { x: W / 2 + off, y1: H * (landscape ? 0.31 : 0.43), scale: side, delay: 0.7, seed: 2026 }),
      ];
      this.bouquet = new BouquetVision(W, H);
    }
    draw(frame, t) {
      frame.px.set(this.background.px);
      this.sky.draw(frame, t);
      for (const fw of this.fireworks) fw.draw(frame, t);  // derrière les lys : les fusées sortent des fleurs
      for (const s of this.shrubs) s.draw(frame, t);
      this.ground.draw(frame, t);
      this.bouquet.draw(frame, t);   // après les retombées du feu d'artifice
      this.petals.draw(frame, t);
      this.motes.draw(frame, t);
      this.hearts.draw(frame, t);
    }
  }

  // ===================================================================
  // Invitation à tourner le téléphone (sans texte)
  // ===================================================================
  /*
   * Sur téléphone tenu à la verticale : la scène est voilée et un petit
   * téléphone en pixel art pivote à l'horizontale sous une flèche courbe,
   * un cœur battant à l'écran. Safari ne permet pas de forcer la rotation :
   * on invite, et un simple toucher permet de continuer en portrait.
   */
  class RotatePrompt {
    constructor() {
      this.edge = hexRgb('#ffe6f0');
      this.shade = hexRgb('#ffb3d1');
      this.screen = hexRgb('#2a1d3d');
      this.arrow = hexRgb('#ff9ec4');
      this.heart = PALETTE.rose.map(hexRgb);
    }

    draw(frame, t) {
      const cx = frame.w >> 1, cy = Math.round(frame.h * 0.44);
      const P = 3.4, ph = t % P;
      const quarter = -Math.PI / 2;
      const ang = ph < 1.0 ? 0 : ph < 1.7 ? quarter * smooth((ph - 1.0) / 0.7)
        : ph < 2.7 ? quarter : quarter * (1 - smooth((ph - 2.7) / 0.7));
      const ca = Math.cos(-ang), sa = Math.sin(-ang);

      // téléphone : rectangle arrondi qui pivote, bord clair, écran sombre
      const hw = 11, hh = 18, rr = 4;
      const inRect = (x, y, w, h, r) => {
        const qx = Math.abs(x) - (w - r), qy = Math.abs(y) - (h - r);
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= r;
      };
      for (let dy = -22; dy <= 22; dy++) {
        for (let dx = -22; dx <= 22; dx++) {
          const lx = dx * ca - dy * sa, ly = dx * sa + dy * ca;
          if (!inRect(lx, ly, hw, hh, rr)) continue;
          let col;
          if (inRect(lx, ly, hw - 2, hh - 2, rr - 2)) col = this.screen;
          else col = dx + dy < 0 ? this.edge : this.shade;
          if (Math.abs(lx) <= 3 && ly < -hh + 2.5 && ly > -hh + 0.5) col = this.screen;  // encoche
          frame.blend(cx + dx, cy + dy, col, 1);
        }
      }

      // cœur qui bat au milieu de l'écran
      const beat = 0.75 + 0.25 * Math.max(0, Math.sin(t * 5.5));
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          if (HEART_MASK[r][c] !== 'X') continue;
          const col = r === 1 && c <= 1 ? this.heart[2] : (r >= 2 && c >= 3) || r === 4 ? this.heart[0] : this.heart[1];
          frame.blend(cx - 2 + c, cy - 2 + r, col, beat);
        }
      }

      // flèche courbe au-dessus, dans le sens de la rotation
      const a = 0.55 + 0.45 * (ph < 1.0 ? 1 : 0.6);
      const R0 = 28;
      for (let k = 0; k <= 40; k++) {
        const th = lerp(-0.22, -0.78, k / 40) * Math.PI;
        for (const rad of [R0, R0 + 1]) frame.blend(Math.round(cx + Math.cos(th) * rad), Math.round(cy + Math.sin(th) * rad), this.arrow, a);
      }
      const te = -0.78 * Math.PI;
      const hx = cx + Math.cos(te) * (R0 + 0.5), hy = cy + Math.sin(te) * (R0 + 0.5);
      for (const [ox, oy] of [[0, 0], [-1, 0], [-2, 0], [0, 1], [0, 2], [-1, 1], [1, -1], [-1, -1]]) {
        frame.blend(Math.round(hx) + ox, Math.round(hy) + oy, this.arrow, a);
      }
    }
  }

  // ===================================================================
  // Application : dimensionnement net, boucle, pause, mouvement réduit
  // ===================================================================
  class App {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.buffer = document.createElement('canvas');
      this.bctx = this.buffer.getContext('2d');
      this.time = 0;
      this.raf = 0;
      this.last = 0;
      this.lastRender = 0;
      this.cost = 0;          // moyenne glissante du coût d'une image (ms)
      this.lowPower = false;  // passe à 30 i/s si l'appareil peine
      this.reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      // téléphone tactile : on invite à passer à l'horizontale
      const coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
      this.phone = (coarse && Math.min(screen.width, screen.height) < 600) || /[?&]rotate=1/.test(location.search);
      this.prompt = new RotatePrompt();
      this.prompting = false;
      this.dismissed = false;
      this.promptTime = 0;

      this.resize();
      let pending = 0;
      const onResize = () => { clearTimeout(pending); pending = setTimeout(() => this.resize(), 120); };
      window.addEventListener('resize', onResize);
      // iOS publie parfois les nouvelles dimensions après l'événement de rotation
      window.addEventListener('orientationchange', () => { onResize(); setTimeout(() => this.resize(), 450); });
      if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
      // un toucher permet de rester en portrait
      canvas.addEventListener('pointerup', () => {
        if (!this.prompting) return;
        this.dismissed = true;
        this.updatePrompt();
        this.render();
      });
      // pas de zoom ni de rebond sur iOS
      const block = (e) => e.preventDefault();
      document.addEventListener('gesturestart', block);
      document.addEventListener('touchmove', block, { passive: false });
      document.addEventListener('dblclick', block);
      document.addEventListener('visibilitychange', () => this.updateRunning());
      if (this.reduced) {
        const cb = () => this.updateRunning();
        if (this.reduced.addEventListener) this.reduced.addEventListener('change', cb);
        else if (this.reduced.addListener) this.reduced.addListener(cb);
      }
      this.updateRunning();
    }

    /*
     * Facteur d'échelle ENTIER en pixels physiques : chaque pixel art
     * couvre exactement s × s pixels de l'écran. La largeur interne
     * s'adapte au format (portrait / paysage), la hauteur reste ≈ 426.
     */
    resize() {
      const dpr = window.devicePixelRatio || 1;
      const vw = window.innerWidth, vh = window.innerHeight;
      const devW = Math.round(vw * dpr), devH = Math.round(vh * dpr);
      if (!devW || !devH) {  // fenêtre pas encore mise en page : on réessaie
        requestAnimationFrame(() => this.resize());
        return;
      }
      const target = vw > vh ? CONFIG.targetHeightLandscape : CONFIG.targetHeight;
      const s = Math.max(1, Math.round(devH / target));
      const W = Math.ceil(devW / s), H = Math.ceil(devH / s);

      this.canvas.width = W * s;
      this.canvas.height = H * s;
      this.canvas.style.width = (W * s) / dpr + 'px';
      this.canvas.style.height = (H * s) / dpr + 'px';
      // centré horizontalement, aligné en bas, sur la grille des pixels physiques
      this.canvas.style.left = Math.floor((devW - W * s) / 2) / dpr + 'px';
      this.canvas.style.top = (devH - H * s) / dpr + 'px';

      if (!this.scene || this.W !== W || this.H !== H) {
        this.W = W; this.H = H;
        this.buffer.width = W; this.buffer.height = H;
        this.image = this.bctx.createImageData(W, H);
        this.frame = new Frame(W, H, new Uint32Array(this.image.data.buffer));
        this.scene = new Scene(W, H);
      }
      this.scale = s;
      this.updatePrompt();
      this.render();
    }

    /** Invitation active : téléphone, à la verticale, pas encore ignorée. */
    updatePrompt() {
      const was = this.prompting;
      this.prompting = this.phone && window.innerHeight > window.innerWidth && !this.dismissed;
      // le spectacle (feux d'artifice compris) démarre au moment où l'on tourne
      if (was && !this.prompting) this.time = 0;
    }

    render() {
      if (!this.scene) return;
      const t0 = performance.now();
      const t = this.prompting ? CONFIG.promptTime : this.isReduced() ? CONFIG.stillTime : this.time % T;
      this.scene.draw(this.frame, t);
      if (this.prompting) {
        this.frame.dim(0.42);
        this.prompt.draw(this.frame, this.isReduced() ? 1.2 : this.promptTime);
      }
      this.bctx.putImageData(this.image, 0, 0);
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.drawImage(this.buffer, 0, 0, this.W * this.scale, this.H * this.scale);
      this.cost = lerp(this.cost, performance.now() - t0, 0.05);
      if (!this.lowPower && this.cost > 12) this.lowPower = true;
    }

    isReduced() { return !!(this.reduced && this.reduced.matches); }

    updateRunning() {
      const run = !document.hidden && !this.isReduced();
      if (run && !this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame((n) => this.tick(n));
      } else if (!run && this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
      if (!run) this.render(); // image fixe (mouvement réduit)
    }

    tick(now) {
      this.raf = requestAnimationFrame((n) => this.tick(n));
      // temps réel (même si le navigateur espace les images) ; seuls les
      // très grands sauts sont écrêtés, l'onglet masqué étant déjà en pause
      const dt = Math.min(0.5, Math.max(0, (now - this.last) / 1000));
      if (this.prompting) this.promptTime += dt;
      else this.time += dt;
      this.last = now;
      if (this.lowPower && now - this.lastRender < 30) return;
      this.lastRender = now;
      this.render();
    }
  }

  function start() {
    const canvas = document.getElementById('garden');
    if (canvas && canvas.getContext) window.lilyGarden = new App(canvas);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
