// Design-token verification: WCAG AA text contrast, chart-palette
// distinguishability under deuteranopia, and generated-CSS/source parity.
// Source of truth: scripts/tokens.mjs. Generated output: public/css/tokens.css.
// If any assertion fails here, fix the TOKENS (or generator) — never this test's
// thresholds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, UI_TOKENS, CHART_PALETTES, AA_TEXT_ON } from '../scripts/tokens.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS_PATH = join(ROOT, 'public', 'css', 'tokens.css');
const AA_MIN_RATIO = 4.5;
const MIN_DEUTAN_DELTA_E = 12;

// ---------------------------------------------------------------------------
// Colour math helpers
// ---------------------------------------------------------------------------

export function hexToRgb01(hex) {
  const m = /^#[0-9a-f]{6}$/i.exec(String(hex).trim());
  assert.ok(m, `expected 6-digit hex colour, got "${hex}"`);
  const n = parseInt(m[0].slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** WCAG 2.x relative luminance of a hex colour. */
export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb01(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours. */
export function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Deuteranopia (red-blind) simulation as a linear-RGB matrix approximation.
 * Matrix: Viénot, Brettel & Mollon (1999), "Digital video colourmaps for
 * checking the legibility of displays by dichromats", JOSA A — the standard
 * Brettel/Viénot-style 3x3 projection, applied here to linearised sRGB
 * channels per their method (spectral-sharpened L/M cone collapse).
 */
const DEUTANOPIA_LINEAR_RGB = [
  [0.625, 0.375, 0.0],
  [0.7, 0.3, 0.0],
  [0.0, 0.3, 0.7],
];

/** Hex -> simulated hex as seen by a deuteranope. */
export function simulateDeuteranopia(hex) {
  const lin = hexToRgb01(hex).map(srgbToLinear);
  const simLin = DEUTANOPIA_LINEAR_RGB.map(
    (row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2],
  );
  const [r, g, b] = simLin.map((c) => Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// sRGB -> CIE XYZ (D65) -> CIE L*a*b*, then CIE76 deltaE.
const SRGB_LINEAR_TO_XYZ_D65 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const D65_WHITE = [0.95047, 1.0, 1.08883];

/** Linear RGB (0..1 per channel) -> CIE Lab (D65 reference white). */
export function linearRgbToLab(lin) {
  const [X, Y, Z] = SRGB_LINEAR_TO_XYZ_D65.map(
    (row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2],
  );
  const eps = 216 / 24389;
  const kappa = 24389 / 27;
  const f = (t) => (t > eps ? Math.cbrt(t) : (kappa * t + 16) / 116);
  const [fx, fy, fz] = [X / D65_WHITE[0], Y / D65_WHITE[1], Z / D65_WHITE[2]].map(f);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Hex colours -> Lab, going through the deuteranopia simulation when asked. */
function hexToLab(hex, { deutan = false } = {}) {
  if (deutan) {
    const lin = hexToRgb01(hex).map(srgbToLinear);
    const simLin = DEUTANOPIA_LINEAR_RGB.map(
      (row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2],
    );
    return linearRgbToLab(simLin);
  }
  return linearRgbToLab(hexToRgb01(hex).map(srgbToLinear));
}

/** CIE76 colour difference between two Lab colours. */
export function deltaE76(labA, labB) {
  return Math.hypot(labA[0] - labB[0], labA[1] - labB[1], labA[2] - labB[2]);
}

// ---------------------------------------------------------------------------
// 1) WCAG AA contrast — every declared text-on-surface pairing
// ---------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`[${theme}] every AA_TEXT_ON pair meets WCAG AA (>= ${AA_MIN_RATIO}:1)`, () => {
    assert.ok(AA_TEXT_ON[theme], `AA_TEXT_ON missing theme "${theme}"`);
    const failures = [];
    for (const [fgToken, bgToken] of AA_TEXT_ON[theme]) {
      const fg = UI_TOKENS[theme]?.[fgToken];
      const bg = UI_TOKENS[theme]?.[bgToken];
      assert.ok(fg && bg, `unknown token pair ${fgToken}/${bgToken} in theme "${theme}"`);
      const ratio = contrastRatio(fg, bg);
      if (!(ratio >= AA_MIN_RATIO)) {
        failures.push(
          `${fgToken} ${fg} on ${bgToken} ${bg} -> ${ratio.toFixed(2)}:1 (< ${AA_MIN_RATIO}:1)`,
        );
      }
    }
    assert.deepEqual(
      failures,
      [],
      `WCAG AA contrast failures in "${theme}" theme (fix tokens, not the test):\n  ` +
        failures.join('\n  '),
    );
  });
}

// ---------------------------------------------------------------------------
// 2) Chart palette: unique colours + deuteranopia pairwise distinguishability
// ---------------------------------------------------------------------------

test('every chart palette has at least 6 unique colours', () => {
  for (const theme of THEMES) {
    const palette = CHART_PALETTES[theme];
    const unique = new Set(palette.map((h) => h.toLowerCase()));
    assert.ok(
      unique.size >= 6,
      `"${theme}" palette has only ${unique.size} unique colours: ${palette.join(', ')}`,
    );
  }
});

for (const theme of THEMES) {
  test(`[${theme}] chart palette stays distinguishable under deuteranopia (deltaE >= ${MIN_DEUTAN_DELTA_E})`, () => {
    const palette = CHART_PALETTES[theme];
    const failures = [];
    for (let i = 0; i < palette.length; i++) {
      for (let j = i + 1; j < palette.length; j++) {
        const labA = hexToLab(palette[i], { deutan: true });
        const labB = hexToLab(palette[j], { deutan: true });
        const dE = deltaE76(labA, labB);
        if (!(dE >= MIN_DEUTAN_DELTA_E)) {
          failures.push(
            `series ${i + 1} ${palette[i]} (${simulateDeuteranopia(palette[i])} simulated)` +
              ` vs series ${j + 1} ${palette[j]} (${simulateDeuteranopia(palette[j])} simulated)` +
              ` -> deltaE ${dE.toFixed(1)} (< ${MIN_DEUTAN_DELTA_E})`,
          );
        }
      }
    }
    assert.deepEqual(
      failures,
      [],
      `Deuteranopia-confusable chart series in "${theme}" theme ` +
        `(fix CHART_PALETTES, not the test):\n  ` +
        failures.join('\n  '),
    );
  });
}

// ---------------------------------------------------------------------------
// 3) Generated public/css/tokens.css matches scripts/tokens.mjs exactly
// ---------------------------------------------------------------------------

function parseThemeBlocks(css) {
  const blocks = {};
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const themeMatch = selector.match(/\[data-theme='([^']+)'\]/);
    if (!themeMatch) continue;
    const vars = {};
    for (const decl of body.split(';')) {
      const m = decl.match(/(^|\s)(--[\w-]+)\s*:\s*(.+?)\s*$/);
      if (m) vars[m[2]] = m[3];
    }
    blocks[themeMatch[1]] = vars;
  }
  return blocks;
}

test('generated tokens.css matches token source (UI tokens + chart order)', () => {
  const css = readFileSync(CSS_PATH, 'utf8');
  const blocks = parseThemeBlocks(css);

  const problems = [];
  for (const theme of THEMES) {
    const vars = blocks[theme];
    if (!vars) {
      problems.push(`no [data-theme='${theme}'] block found in tokens.css`);
      continue;
    }
    for (const [token, value] of Object.entries(UI_TOKENS[theme])) {
      const varName = `--${token}`;
      if (!(varName in vars)) {
        problems.push(`[${theme}] missing declaration ${varName}: ${value};`);
      } else if (vars[varName].toLowerCase() !== value.toLowerCase()) {
        problems.push(
          `[${theme}] ${varName} is ${vars[varName]} in CSS but ${value} in source`,
        );
      }
    }
    CHART_PALETTES[theme].forEach((hex, i) => {
      const varName = `--chart-${i + 1}`;
      if (!(varName in vars)) {
        problems.push(`[${theme}] missing declaration ${varName}: ${hex};`);
      } else if (vars[varName].toLowerCase() !== hex.toLowerCase()) {
        problems.push(
          `[${theme}] ${varName} is ${vars[varName]} in CSS but ${hex} in source (order matters)`,
        );
      }
    });
  }
  assert.deepEqual(problems, [], `tokens.css out of sync with scripts/tokens.mjs:\n  ` + problems.join('\n  '));
});
