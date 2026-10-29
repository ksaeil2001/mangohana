import type { PreparedPageImage } from "./projectTypes.js";

const pageFileNameCollator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

export function naturalSortPageFiles(files: PreparedPageImage[]): PreparedPageImage[] {
  return [...files].sort((left, right) => pageFileNameCollator.compare(left.fileName, right.fileName));
}

export function dedupePageFiles(files: PreparedPageImage[]): {
  files: PreparedPageImage[];
  duplicateIds: string[];
} {
  const seenKeys = new Set<string>();
  const uniqueFiles: PreparedPageImage[] = [];
  const duplicateIds: string[] = [];

  for (const file of files) {
    const key = preparedPageImageKey(file);
    if (seenKeys.has(key)) {
      duplicateIds.push(file.id);
      continue;
    }

    seenKeys.add(key);
    uniqueFiles.push(file);
  }

  return { files: uniqueFiles, duplicateIds };
}

function preparedPageImageKey(file: PreparedPageImage): string {
  if (file.sourcePath) return `path:${normalizeWindowsPath(file.sourcePath)}`;
  if (file.importBatchId && file.preparedImageId) {
    return `opaque:${file.importBatchId}:${file.preparedImageId}`;
  }
  return `id:${file.id}`;
}

export function movePageFile(
  files: PreparedPageImage[],
  id: string,
  destinationIndex: number
): PreparedPageImage[] {
  const sourceIndex = files.findIndex((file) => file.id === id);
  if (sourceIndex < 0) return [...files];

  const movedFiles = [...files];
  const [file] = movedFiles.splice(sourceIndex, 1);
  const boundedIndex = Math.max(0, Math.min(destinationIndex, movedFiles.length));
  movedFiles.splice(boundedIndex, 0, file!);
  return movedFiles;
}

function normalizeWindowsPath(sourcePath: string): string {
  const windowsPath = sourcePath.replaceAll("/", "\\");
  const prefix = windowsPath.startsWith("\\\\") ? "\\\\" : windowsPath.startsWith("\\") ? "\\" : "";
  const segments = windowsPath.slice(prefix.length).split("\\");
  const normalizedSegments: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === ".") continue;

    if (segment === "..") {
      const previous = normalizedSegments.at(-1);
      if (previous && previous !== ".." && !/^[a-z]:$/i.test(previous)) {
        normalizedSegments.pop();
      } else if (!prefix) {
        normalizedSegments.push(segment);
      }
      continue;
    }

    normalizedSegments.push(segment);
  }

  return `${prefix}${normalizedSegments.join("\\")}`.toLocaleLowerCase("en-US");
}
