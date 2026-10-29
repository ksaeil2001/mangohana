import type { DialogueLine, TranslationProject } from "./projectTypes.js";

export function formatTranslationTxt(project: TranslationProject): string {
  const lines = [...project.dialogueLines]
    .sort((left, right) =>
      left.pageNumber !== right.pageNumber
        ? left.pageNumber - right.pageNumber
        : left.order - right.order
    )
    .map((line) =>
      [padOrder(line.order), firstNonBlank(line.speaker) ?? "", formatPosition(line), selectFinalText(line)].join("\t")
    );

  return [`# ${project.metadata.title}`, "", ...lines, ""].join("\n");
}

function selectFinalText(line: DialogueLine): string {
  const raw =
    firstNonBlank(line.userTranslation) ??
    firstNonBlank(line.aiTranslation) ??
    firstNonBlank(line.referenceTranslation) ??
    line.sourceText.trim();

  return raw.replace(/[\r\n\t]+/g, " ").trim();
}


function formatPosition(line: DialogueLine): string {
  return firstNonBlank(line.position) ?? line.dialogueType;
}

function firstNonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function padOrder(order: number): string {
  return order.toString().padStart(3, "0");
}
