// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { auditDesignSystem, inspectColor, targetClasses } from "../../scripts/design-system-audit.mjs";
import { runChecks } from "../../scripts/lint.mjs";

const renderer = path.resolve("fixture/src/renderer");
const themeFile = path.join(renderer, "design-tokens.css");
const uiFile = path.join(renderer, "components/Ui.tsx");
const variables = new Set(["--trio-text", "--trio-accent"]);
function audit(css, jsx, extra = {}) {
  return auditDesignSystem({
    themeFile, uiFile,
    cssSources: [{ file: themeFile, text: ":root { --trio-text: #fff; --trio-accent: rgb(1 2 3); }" }, { file: path.join(renderer, "styles.css"), text: css }],
    tsxSources: [{ file: path.join(renderer, "components/Page.tsx"), text: jsx }], ...extra
  });
}

describe("ordinary CSS design-system audit", () => {
  it("allows theme references, harmless fallbacks, transparent, geometry and URL contents", () => {
    expect(inspectColor("var(--trio-text)", "color", variables)).toEqual([]);
    expect(inspectColor("var(--optional, var(--trio-text))", "color", variables)).toEqual([]);
    expect(inspectColor('url("image#abcdef.png") transparent', "background", variables)).toEqual([]);
    expect(inspectColor("0 2px 8px var(--trio-accent)", "box-shadow", variables)).toEqual([]);
    expect(inspectColor("brightness(0.94) blur(2px)", "filter", variables)).toEqual([]);
    expect(inspectColor("underline line-through", "text-decoration", variables)).toEqual([]);
    expect(inspectColor("drop-shadow(0 0 2px red)", "filter", variables).some((item) => item.code === "raw-color")).toBe(true);
    const result = audit(".layout { margin: 4px; width: 100%; transform: scale(2); }", 'import { Button } from "./Ui.js"; const view = <Button className="layout" style={{width: 100, transform: "scale(2)"}} />;');
    expect(result.diagnostics).toEqual([]);
  });

  it("catches named colors, shadow/gradient/shorthand literals and fallback literals", () => {
    for (const [value, property] of [["red", "color"], ["1px solid #fff", "border"], ["0 2px rgba(0,0,0,.5)", "box-shadow"], ["linear-gradient(to bottom, var(--trio-text), red)", "background"], ["var(--optional, #fff)", "color"]]) {
      expect(inspectColor(value, property, variables).some((item) => item.code === "raw-color")).toBe(true);
    }
    expect(inspectColor("var(--unknown)", "color", variables)).toEqual([{ code: "unknown-variable", value: "--unknown" }]);
    expect(inspectColor("rebeccapurple", "--local-color", variables)).toEqual([{ code: "raw-color", value: "rebeccapurple" }]);
  });

  it("does not classify descendant styling as a change to the parent root", () => {
    expect(targetClasses(".consumer .child:hover")).toEqual(["child"]);
    expect(targetClasses(".consumer:hover")).toEqual(["consumer"]);
    expect(targetClasses(".consumer:not(.disabled)")).toBeNull();
    const result = audit(".consumer .child { color: var(--trio-text); }", 'import { Button } from "./Ui.js"; const view = <Button className="consumer" />;');
    expect(result.diagnostics).toEqual([]);
    const scoped = audit(".page .secondary-button { padding: 4px; }", "");
    expect(scoped.diagnostics.map((item) => [item.code, item.severity])).toEqual([["scoped-button-review", "warning"]]);
  });

  it("finds CSS appearance via renamed imports, namespace imports and conditional/template classes", () => {
    const result = audit(".danger:hover { border-color: var(--trio-accent); } .vertical { display: flex; }", `
      import { SettingsRow as Row } from "./Ui.js";
      import * as Ui from "./Ui.js";
      const view = <><Row className={ok ? "vertical" : "danger"} />
        <Ui.Button className={\`vertical \${ok ? "danger" : ""}\`} /></>;
    `);
    expect(result.diagnostics.filter((item) => item.code === "component-restyle-review" && item.severity === "warning")).toHaveLength(2);
  });

  it("respects Feedback/PageHeader prop forwarding and preserves component internals", () => {
    const result = audit(".danger { color: var(--trio-accent); }", `
      import { Feedback, PageHeader } from "./Ui.js";
      const view = <><Feedback className="danger" /><PageHeader className="danger" />
        <Feedback style={{fontSize: 14}} /></>;
    `);
    expect(result.diagnostics.filter((item) => item.code === "component-restyle")).toHaveLength(1);
    const internals = audit("", "", { tsxSources: [{ file: uiFile, text: "export function Button() { return <button style={{padding: 4}} />; }" }] });
    expect(internals.diagnostics).toEqual([]);
  });

  it("checks statically known style objects/spreads but records unreadable input", () => {
    const result = audit("", `import { Button as Action } from "./Ui.js";
      const shared = { color: "#f00" };
      const view = <><Action style={{...shared, width: 50}} /><Action style={external} /></>;
    `);
    expect(result.diagnostics.some((item) => item.code === "component-restyle")).toBe(true);
    expect(result.diagnostics.some((item) => item.code === "raw-color")).toBe(true);
    expect(result.coverage.unreadableStyles).toBe(1);
    expect(result.diagnostics.some((item) => item.code === "unreadable-style" && item.severity === "warning")).toBe(true);
  });

  it("allows declarations outside the token file and inline custom properties but checks their literal values", () => {
    const result = audit(":root { --local: var(--trio-text); } .a { color: var(--local); border-color: var(--from-inline); }", 'const view = <div style={{"--from-inline": "var(--trio-accent)"}} />;');
    expect(result.diagnostics).toEqual([]);
    const raw = audit("", 'const view = <div style={{"--raw": "#f00"}} />;');
    expect(raw.diagnostics.map((item) => item.code)).toEqual(["raw-color"]);
  });

  it("does not hide parser failures or invalid references inside the token file", () => {
    expect(() => audit(".broken {", "")).toThrow();
    expect(audit("", "const view = <").diagnostics.some((item) => item.code === "parse-error")).toBe(true);
    const result = audit("", "", { cssSources: [{ file: themeFile, text: ":root { --trio-text: var(--missing); }" }] });
    expect(result.diagnostics.map((item) => item.code)).toEqual(["unknown-variable"]);
  });

  it("keeps constants scoped to their function and block", () => {
    const result = audit(".danger { color: var(--trio-accent); }", `import { Button } from "./Ui.js";
      function a() { const cls = "danger"; return <Button className={cls} />; }
      function b() { const cls = "layout"; return <Button className={cls} />; }
    `);
    expect(result.diagnostics.filter((item) => item.code === "component-restyle")).toHaveLength(1);
  });

  it("records dynamic template coverage and follows known class helpers", () => {
    const result = audit(".danger { color: var(--trio-accent); }", 'import { Button } from "./Ui.js"; const view = <><Button className={cn("layout", ok && "danger")} /><Button className={`layout ${external}`} /></>;');
    expect(result.diagnostics.filter((item) => item.code === "component-restyle")).toHaveLength(1);
    expect(result.coverage.unreadableClassNames).toBe(1);
  });

  it("resolves initializers where declared and blocks unsupported shadowing bindings", () => {
    const result = audit(".danger { color: var(--trio-accent); }", `import { Button } from "./Ui.js";
      const colorClass = "danger"; const shared = colorClass;
      function a() { const colorClass = "layout"; return <Button className={shared} />; }
      function b([colorClass]) { return <Button className={colorClass} />; }
      function c() { let colorClass = external; return <Button className={colorClass} />; }
      function d() { const { colorClass } = external; return <Button className={colorClass} />; }
      function e() { try { return null; } catch(colorClass) { return <Button className={colorClass} />; } }
      function f() { function colorClass() {} return <Button className={colorClass} />; }
    `);
    expect(result.diagnostics.filter((item) => item.code === "component-restyle")).toHaveLength(1);
    expect(result.coverage.unreadableClassNames).toBe(5);
  });

  it("excludes an incompatible root tag and keeps conditional selectors as review warnings", () => {
    const result = audit("div.danger { color: var(--trio-accent); } .parent .candidate { color: var(--trio-accent); } .candidate#special { padding: 8px; }", 'import { Button } from "./Ui.js"; const view = <Button className="danger candidate" />;');
    expect(result.diagnostics.map((item) => [item.code, item.severity])).toEqual([["component-restyle-review", "warning"], ["component-restyle-review", "warning"]]);
  });

  it("does not mistake a shadowing local component or namespace for the imported UI", () => {
    const result = audit("", 'import { Button } from "./Ui.js"; import * as Ui from "./Ui.js"; function a(Button) { return <Button style={{padding: 4}} />; } function b(Ui) { return <Ui.Button style={{padding: 4}} />; }');
    expect(result.diagnostics).toEqual([]);
  });

  it("records dynamically supplied color values without counting geometry as unchecked color", () => {
    const result = audit("", 'const view = <div style={{color: external, width: width, "--page-width": 100}} />;');
    expect(result.coverage.unreadableColorValues).toBe(1);
    expect(result.diagnostics).toEqual([]);
  });

  it("limits catch binding shadowing to the catch block", () => {
    const result = audit(".danger { color: var(--trio-accent); }", 'import { Button } from "./Ui.js"; function a() { const cls = "danger"; try {} catch(cls) { const inside = <Button className={cls} />; } return <Button className={cls} />; }');
    expect(result.diagnostics.filter((item) => item.code === "component-restyle")).toHaveLength(1);
    expect(result.coverage.unreadableClassNames).toBe(1);
  });
});

describe("combined lint exit status", () => {
  it("runs both checks after an error, nonzero exit or signal and reports failure", () => {
    for (const first of [{ status: 1 }, { status: null }, { status: null, error: new Error("spawn failed") }]) {
      const run = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce({ status: 0 });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(runChecks([["jsx"], ["css"]], run)).toBe(1);
      expect(run).toHaveBeenCalledTimes(2);
      log.mockRestore();
    }
  });
  it("returns success only if every check succeeds", () => {
    expect(runChecks([["jsx"], ["css"]], () => ({ status: 0 }))).toBe(0);
    const run = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 1 });
    expect(runChecks([["jsx"], ["css"]], run)).toBe(1);
  });
});
