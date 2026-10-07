// File-level operations shared by the command line and the desktop app.

import { readFile, writeFile, readdir, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { convertBpmnToDrawio, extractBpmnFromDrawio } from './converter.js';

export const BPMN_EXTENSIONS = ['.bpmn', '.bpmn20.xml'];
export const DRAWIO_EXTENSIONS = ['.drawio'];

export function isBpmnFile(file) {
  const lower = file.toLowerCase();
  return BPMN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isDrawioFile(file) {
  const lower = file.toLowerCase();
  return DRAWIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Expands folders into the .bpmn files they contain (not recursive). */
export async function expandInputs(inputs) {
  const files = [];
  for (const input of inputs) {
    const info = await stat(input);
    if (info.isDirectory()) {
      const entries = await readdir(input);
      for (const entry of entries.sort()) {
        if (isBpmnFile(entry)) files.push(path.join(input, entry));
      }
    } else {
      files.push(input);
    }
  }
  return files;
}

/**
 * Converts one file, chosen by its extension:
 * - .bpmn   -> .drawio (overwrites a previous conversion)
 * - .drawio -> .bpmn   (restores the embedded BPMN; never overwrites an existing file)
 *
 * @param {string} input
 * @param {{ outDir?: string }} [options] outDir defaults to the input's folder.
 */
export async function convertFile(input, options = {}) {
  const outDir = options.outDir || path.dirname(input);
  const base = path.basename(input).replace(/(\.bpmn20\.xml|\.bpmn|\.drawio)$/i, '');

  if (isDrawioFile(input)) {
    const extracted = extractBpmnFromDrawio(await readFile(input, 'utf8'));
    if (!extracted) {
      throw new Error("Ce fichier draw.io ne contient pas de BPMN d'origine (il n'a pas été créé par cet outil).");
    }
    const output = await uniquePath(path.join(outDir, `${base}.bpmn`));
    await writeFile(output, extracted.bpmnXml, 'utf8');
    return { input, output, mode: 'restore', warnings: [] };
  }

  if (!isBpmnFile(input)) {
    throw new Error('Format non reconnu : seuls les fichiers .bpmn et .drawio sont acceptés.');
  }

  const xml = await readFile(input, 'utf8');
  const result = await convertBpmnToDrawio(xml, { fileName: path.basename(input) });
  const output = path.join(outDir, `${base}.drawio`);
  await writeFile(output, result.xml, 'utf8');
  return { input, output, mode: 'convert', pages: result.pages, warnings: result.warnings };
}

async function uniquePath(file) {
  if (!(await exists(file))) return file;
  const { dir, name, ext } = path.parse(file);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${name} (restauré${i > 1 ? ` ${i}` : ''})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
