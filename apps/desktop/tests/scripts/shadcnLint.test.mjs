// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();

function lintFixture(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "trio-shadcn-rules-"));
  const config = JSON.parse(fs.readFileSync(path.join(root, ".oxlintrc.json"), "utf8"));
  delete config.$schema;
  config.jsPlugins = [path.join(root, "node_modules/@shadcn/lint/dist/index.js").replaceAll("\\", "/")];
  fs.writeFileSync(path.join(directory, "package.json"), '{"name":"isolated-rule-fixture","private":true}');
  fs.writeFileSync(path.join(directory, "Ui.tsx"), "export function Button({className, ...props}) { return <button {...props} className={className} />; }");
  fs.writeFileSync(path.join(directory, "fixture.tsx"), source);
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify(config));
  const result = spawnSync(process.execPath, [
    path.join(root, "node_modules/oxlint/bin/oxlint"), "-c", path.join(directory, "config.json"),
    "-f", "json", path.join(directory, "fixture.tsx")
  ], { cwd: directory, encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, diagnostics: JSON.parse(result.stdout).diagnostics };
}

describe("Trio Shadcn rule policy", () => {
  it("accepts layout, geometry, theme SVG colors and ordinary CSS class names", () => {
    const result = lintFixture(`
      import { Button } from "./Ui.js";
      const view = <><Button variant="primary" className="w-full mt-4 trio-layout" style={{width: 100, transform: "scale(2)"}} />
        <svg fill="currentColor" stroke="var(--trio-accent)" />
        <div className="w-[320px]" style={{color: "var(--trio-text)"}} /></>;
    `);
    expect(result).toEqual({ status: 0, diagnostics: [] });
  });

  it("rejects raw SVG colors, Tailwind appearance overrides and common-component inline appearance", () => {
    const result = lintFixture(`
      import { Button } from "./Ui.js";
      const view = <><Button className="bg-red-500 p-4 rounded-full" style={{color: "var(--trio-text)", padding: 8}} />
        <svg fill="#ff0000" /><path stroke="red" /></>;
    `);
    expect(result.status).toBe(1);
    const counts = Object.groupBy(result.diagnostics, (item) => item.code);
    expect(counts["shadcn(no-restyle)"].length).toBe(3);
    expect(counts["shadcn(no-inline-styles)"].length).toBe(2);
    expect(counts["shadcn(no-raw-colors)"].length).toBe(3);
  });

  it("rejects arbitrary color literals while leaving arbitrary layout dimensions alone", () => {
    const result = lintFixture('const view = <div className="bg-[#ff0000] w-[320px]" />;');
    expect(result.status).toBe(1);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["shadcn(no-arbitrary-values)"]);
  });
});
