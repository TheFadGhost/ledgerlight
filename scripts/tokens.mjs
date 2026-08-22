// Design token source of truth. Consumed by scripts/gen-tokens.mjs (CSS output)
// and test/design-tokens.test.mjs (AA contrast + deuteranopia checks).
// Do not hardcode colours anywhere else.

export const THEMES = ['light', 'dark', 'high-contrast'];

export const UI_TOKENS = {
  light: {
    bg: '#f7f6f3',
    surface: '#fffefb',
    'surface-sunken': '#f1efe9',
    border: '#d9d5cc',
    'border-strong': '#b5afa2',
    ink: '#1e1c18',
    'ink-secondary': '#57534a',
    'ink-faint': '#6e6960',
    accent: '#0b6b4f',
    'accent-ink': '#ffffff',
    negative: '#a02c2c',
    positive: '#1a7f37',
    warning: '#8a5a00',
    selection: '#e4efe9',
  },
  dark: {
    bg: '#14161a',
    surface: '#1d2025',
    'surface-sunken': '#171a1f',
    border: '#33383f',
    'border-strong': '#4a505a',
    ink: '#e8eaed',
    'ink-secondary': '#a8adb5',
    'ink-faint': '#8f959e',
    accent: '#3ecf9a',
    'accent-ink': '#06130e',
    negative: '#ff7b72',
    positive: '#4ec96a',
    warning: '#d9a53f',
    selection: '#20342c',
  },
  'high-contrast': {
    bg: '#ffffff',
    surface: '#ffffff',
    'surface-sunken': '#f0f0f0',
    border: '#767676',
    'border-strong': '#000000',
    ink: '#000000',
    'ink-secondary': '#1a1a1a',
    'ink-faint': '#333333',
    accent: '#005a3c',
    'accent-ink': '#ffffff',
    negative: '#a80000',
    positive: '#005a1e',
    warning: '#5c3d00',
    selection: '#d6ecd9',
  },
};

export const CHART_PALETTES = {
  light: ['#0b6b4f', '#b5651d', '#31597e', '#6b4fa1', '#a03a5c', '#5f6b23'],
  dark: ['#3ecf9a', '#e0975a', '#7ab3de', '#b39ae0', '#e07f9f', '#aeb85e'],
  'high-contrast': ['#005a3c', '#7a3e00', '#0f3d66', '#46277d', '#75002c', '#3c4200'],
};

// Text tokens that must meet WCAG AA (>= 4.5:1) against bg or surface.
export const AA_TEXT_ON = {
  light: [
    ['ink', 'bg'], ['ink', 'surface'],
    ['ink-secondary', 'bg'], ['ink-secondary', 'surface'], ['ink-secondary', 'surface-sunken'],
    ['ink-faint', 'bg'], ['ink-faint', 'surface'],
    ['negative', 'bg'], ['negative', 'surface'],
    ['positive', 'bg'], ['positive', 'surface'],
    ['warning', 'bg'], ['warning', 'surface'],
    ['accent-ink', 'accent'],
  ],
  dark: [
    ['ink', 'bg'], ['ink', 'surface'],
    ['ink-secondary', 'bg'], ['ink-secondary', 'surface'], ['ink-secondary', 'surface-sunken'],
    ['ink-faint', 'bg'], ['ink-faint', 'surface'],
    ['negative', 'bg'], ['negative', 'surface'],
    ['positive', 'bg'], ['positive', 'surface'],
    ['warning', 'bg'], ['warning', 'surface'],
    ['accent-ink', 'accent'],
  ],
  'high-contrast': [
    ['ink', 'bg'], ['ink', 'surface'],
    ['ink-secondary', 'bg'], ['ink-secondary', 'surface'], ['ink-secondary', 'surface-sunken'],
    ['ink-faint', 'bg'], ['ink-faint', 'surface'],
    ['negative', 'bg'], ['negative', 'surface'],
    ['positive', 'bg'], ['positive', 'surface'],
    ['warning', 'bg'], ['warning', 'surface'],
    ['accent-ink', 'accent'],
  ],
};
