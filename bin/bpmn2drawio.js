#!/usr/bin/env node
// Command line: converts .bpmn files (or folders of them) to .drawio,
// and restores the original .bpmn from a .drawio created by this tool.

import { mkdir } from 'node:fs/promises';
import { expandInputs, convertFile } from '../src/files.js';

const USAGE = `Utilisation :
  bpmn2drawio <fichiers .bpmn ou dossiers...> [-o dossier_de_sortie]
  bpmn2drawio <fichier.drawio...> [-o dossier_de_sortie]   (récupère le BPMN d'origine)

Options :
  -o, --out <dossier>   Dossier de sortie (par défaut : à côté de chaque fichier)
  -h, --help            Affiche cette aide`;

async function main(argv) {
  const inputs = [];
  let outDir;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      return 0;
    } else if (arg === '-o' || arg === '--out') {
      outDir = argv[++i];
      if (!outDir) {
        console.error('Option -o : dossier manquant.');
        return 2;
      }
    } else {
      inputs.push(arg);
    }
  }
  if (!inputs.length) {
    console.error(USAGE);
    return 2;
  }

  if (outDir) await mkdir(outDir, { recursive: true });

  let files;
  try {
    files = await expandInputs(inputs);
  } catch (err) {
    console.error(`Erreur : ${err.message}`);
    return 1;
  }
  if (!files.length) {
    console.error('Aucun fichier .bpmn trouvé.');
    return 1;
  }

  let failures = 0;
  for (const file of files) {
    try {
      const result = await convertFile(file, { outDir });
      console.log(`✓ ${file} → ${result.output}`);
      for (const warning of result.warnings) console.log(`  ⚠ ${warning}`);
    } catch (err) {
      failures++;
      console.error(`✗ ${file} : ${err.message}`);
    }
  }
  console.log(`${files.length - failures}/${files.length} fichier(s) traité(s).`);
  return failures ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
