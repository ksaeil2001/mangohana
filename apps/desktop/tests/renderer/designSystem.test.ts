import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tokens = readFileSync("src/renderer/design-tokens.css", "utf8");
const blocks = [...tokens.matchAll(/:root(?:\[data-theme="light"\])?\s*\{([^}]+)\}/g)];
const palette = (block: string): Record<string, string> => Object.fromEntries(
  [...block.matchAll(/--trio-([\w-]+):\s*(#[\da-f]{6});/g)].map((match) => [match[1], match[2]])
);
const dark = palette(blocks[0][1]);
const light = { ...dark, ...palette(blocks[1][1]) };

function luminance(hex: string): number {
  const values = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe.each([["light", light], ["dark", dark]] as const)("%s design system", (_theme, colors) => {
  it("keeps body, secondary and caption text readable on all chrome surfaces", () => {
    for (const foreground of ["text", "muted", "subtle"]) {
      for (const background of ["bg", "panel", "panel-raised"]) {
        expect(contrast(colors[foreground], colors[background]), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps actions, review feedback and input boundaries distinguishable", () => {
    expect(contrast(colors["on-accent"], colors.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors["on-accent"], colors["accent-hover"])).toBeGreaterThanOrEqual(4.5);
    for (const tone of ["error", "warning", "success", "accent"]) {
      expect(contrast(colors[tone], colors[`${tone}-soft`]), tone).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(colors.border, colors.panel)).toBeGreaterThanOrEqual(3);
  });
});
