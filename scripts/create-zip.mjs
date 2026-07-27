import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { zipSync } from "fflate";

const ARCHIVE_TIMESTAMP = new Date(2000, 0, 1, 0, 0, 0);

export async function createZip(root, entries, outputPath) {
  const resolvedRoot = resolve(root);
  const archiveFiles = {};

  const sortedEntries = [...entries].sort((left, right) => left.localeCompare(right, "en"));
  for (const entry of sortedEntries) {
    const absoluteEntry = resolve(resolvedRoot, entry);
    if (!isWithinRoot(resolvedRoot, absoluteEntry)) {
      throw new Error(`Archive entry escapes its root: ${entry}`);
    }
    await collectFiles(resolvedRoot, absoluteEntry, archiveFiles);
  }

  const archive = zipSync(archiveFiles, {
    level: 9,
    mtime: ARCHIVE_TIMESTAMP
  });
  await writeFile(outputPath, archive);
}

async function collectFiles(root, currentPath, archiveFiles) {
  const metadata = await stat(currentPath);
  if (metadata.isDirectory()) {
    const children = await readdir(currentPath);
    children.sort((left, right) => left.localeCompare(right, "en"));
    for (const child of children) {
      await collectFiles(root, resolve(currentPath, child), archiveFiles);
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(`Archive entry is not a regular file: ${currentPath}`);
  }

  const archivePath = relative(root, currentPath).split(sep).join(posix.sep);
  archiveFiles[archivePath] = new Uint8Array(await readFile(currentPath));
}

function isWithinRoot(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}
