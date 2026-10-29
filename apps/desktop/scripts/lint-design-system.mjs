import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditDesignSystem } from "./design-system-audit.mjs";

export function auditProject(root = process.cwd()) {
  const directory = path.join(root, "src/renderer");
  const files = fs.readdirSync(directory, { recursive: true }).map((file) => path.join(directory, file));
  const sources = (extension) => files.filter((file) => file.endsWith(extension)).map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));
  return auditDesignSystem({ cssSources: sources(".css"), tsxSources: sources(".tsx"), themeFile: path.join(directory, "design-tokens.css"), uiFile: path.join(directory, "components/Ui.tsx") });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = auditProject();
    if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      for (const item of report.diagnostics) console.log(`${path.relative(process.cwd(), item.file)}:${item.line}:${item.column}: ${item.severity} ${item.code}: ${item.message}`);
      console.log(JSON.stringify({ errors: report.diagnostics.filter((item) => item.severity === "error").length, warnings: report.diagnostics.filter((item) => item.severity === "warning").length, coverage: report.coverage }));
    }
    if (report.diagnostics.some((item) => item.severity === "error")) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
