import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { convertBpmnToDrawio, extractBpmnFromDrawio } from '../src/converter.js';
import { convertFile, expandInputs } from '../src/files.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function parse(xml) {
  const errors = [];
  const doc = new DOMParser({ onError: (level, msg) => errors.push(`${level}: ${msg}`) }).parseFromString(xml, 'text/xml');
  assert.deepEqual(errors, [], 'draw.io XML must be well-formed');
  return doc;
}

function cells(doc) {
  const byId = new Map();
  for (const obj of Array.from(doc.getElementsByTagName('object'))) {
    const cell = obj.getElementsByTagName('mxCell')[0];
    byId.set(obj.getAttribute('id'), { obj, cell });
  }
  return byId;
}

test('sous-processus réduit : une page par diagramme, avec lien vers la page détaillée', async () => {
  const { xml, pages, warnings } = await convertBpmnToDrawio(fixture('sous-processus.bpmn'), { fileName: 'sous-processus.bpmn' });
  assert.equal(pages, 2);
  assert.deepEqual(warnings, []);

  const doc = parse(xml);
  const diagrams = Array.from(doc.getElementsByTagName('diagram'));
  assert.deepEqual(diagrams.map((d) => d.getAttribute('name')), ['sous-processus', 'Truc']);

  const byId = cells(doc);
  const sub = byId.get('Activity_1upykw1');
  assert.equal(sub.obj.getAttribute('link'), 'data:page/id,page-2');
  assert.match(sub.cell.getAttribute('style'), /isLoopSub=1/);

  // Shapes are nested in their lane, with coordinates relative to it.
  const start = byId.get('StartEvent_0eryzc8');
  assert.equal(start.cell.getAttribute('parent'), 'Lane_1vvtmi8');
  const geo = start.cell.getElementsByTagName('mxGeometry')[0];
  assert.equal(geo.getAttribute('x'), '26');
  assert.equal(geo.getAttribute('y'), '82');

  // Gateway labels and bend points are kept.
  const maybe = byId.get('Flow_0wz9pj7');
  assert.equal(maybe.obj.getAttribute('label'), 'Maybe');
  const points = maybe.cell.getElementsByTagName('Array')[0].getElementsByTagName('mxPoint');
  assert.equal(points.length, 1);
  assert.equal(points[0].getAttribute('x'), '600');
  assert.equal(points[0].getAttribute('y'), '540');
});

test('diagramme complet : types BPMN, pools, couloirs et liaisons', async () => {
  const { xml, pages, warnings } = await convertBpmnToDrawio(fixture('complet.bpmn'));
  assert.equal(pages, 1);
  assert.deepEqual(warnings, []);
  const byId = cells(parse(xml));
  const style = (id) => byId.get(id).cell.getAttribute('style');

  assert.match(style('Task_Verifier'), /taskMarker=user/);
  assert.match(style('Task_Commander'), /taskMarker=service/);
  assert.match(style('Sub_Calculer'), /taskMarker=script;.*isLoopMultiParallel=1/);
  assert.match(style('Cat_Receive'), /isLoopMultiSeq=1/);
  assert.match(style('Cat_Manual'), /isLoopStandard=1/);
  assert.match(style('Cat_Call'), /bpmnShapeType=call/);
  assert.match(style('Cat_Transaction'), /bpmnShapeType=transaction/);
  assert.match(style('Cat_EventSub'), /bpmnShapeType=subprocess/);
  assert.match(style('Start_Commande'), /outline=standard;symbol=message/);
  assert.match(style('Boundary_Timer'), /outline=boundNonint;symbol=timer/);
  assert.match(style('End_Refusee'), /outline=end;symbol=terminate;/);
  assert.match(style('Cat_EventSub_Start'), /outline=eventNonint;symbol=timer/);
  assert.match(style('Gateway_OK'), /gwType=exclusive/);
  assert.match(style('Gateway_Split'), /gwType=parallel/);
  assert.match(style('Cat_Inclusive'), /outline=end;symbol=general/);
  assert.match(style('Flow_Non'), /startArrow=dash/, 'default flow marker');
  assert.match(style('MsgFlow_Commande'), /dashed=1;dashPattern=8 4/);
  assert.match(style('Pool_Fournisseur'), /^rounded=0/, 'black box pool');

  // Nesting: lanes in pool, boundary event on its task, sub-process children inside it.
  assert.equal(byId.get('Lane_Back').cell.getAttribute('parent'), 'Pool_Client');
  assert.equal(byId.get('Boundary_Timer').cell.getAttribute('parent'), 'Task_Verifier');
  assert.equal(byId.get('Sub_Calculer').cell.getAttribute('parent'), 'Sub_Preparer');
  assert.equal(byId.get('Cat_Inclusive').cell.getAttribute('parent'), 'Pool_Catalogue');

  // Edges live in the nearest common container of their ends.
  assert.equal(byId.get('Flow_Timer').cell.getAttribute('parent'), 'Pool_Client');
  assert.equal(byId.get('Sub_Flow_1').cell.getAttribute('parent'), 'Sub_Preparer');
  assert.equal(byId.get('Flow_1').cell.getAttribute('parent'), 'Lane_Accueil');
  assert.equal(byId.get('MsgFlow_Commande').cell.getAttribute('parent'), 'page-1-1');

  // Documentation becomes a tooltip; multi-line text keeps its line break.
  assert.equal(byId.get('Task_Verifier').obj.getAttribute('tooltip'), 'Contrôler le stock et le client.');
  assert.equal(byId.get('Annotation_Delai').obj.getAttribute('label'), 'Délai max :<br>48 h');
});

test('le BPMN d’origine est restitué à l’identique', async () => {
  for (const name of ['sous-processus.bpmn', 'complet.bpmn']) {
    const bpmn = fixture(name);
    const { xml } = await convertBpmnToDrawio(bpmn, { fileName: name });
    assert.deepEqual(extractBpmnFromDrawio(xml), { bpmnXml: bpmn, fileName: name });
  }
});

test('restitution depuis un fichier ré-enregistré (compressé) par draw.io', async () => {
  const bpmn = fixture('sous-processus.bpmn');
  const { xml } = await convertBpmnToDrawio(bpmn);
  // draw.io's compressed format: base64(deflateRaw(encodeURIComponent(model))).
  const compressed = xml.replace(/(<diagram\b[^>]*>)([\s\S]*?)(<\/diagram>)/g, (_, open, model, close) =>
    open + deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64') + close
  );
  assert.equal(extractBpmnFromDrawio(compressed).bpmnXml, bpmn);
});

test('option embedSource: false et fichiers sans BPMN', async () => {
  const { xml } = await convertBpmnToDrawio(fixture('sous-processus.bpmn'), { embedSource: false });
  assert.equal(extractBpmnFromDrawio(xml), null);
});

test('erreurs explicites', async () => {
  await assert.rejects(convertBpmnToDrawio('pas du xml'), /illisible/);
  const noDi = '<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="x"><bpmn:process id="p"/></bpmn:definitions>';
  await assert.rejects(convertBpmnToDrawio(noDi), /aucune information graphique/);
});

test('fichiers : conversion, dossier et restauration sans écrasement', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bpmn2drawio-'));
  try {
    const bpmnPath = path.join(dir, 'processus.bpmn');
    await copyFile(new URL('./fixtures/sous-processus.bpmn', import.meta.url), bpmnPath);
    await writeFile(path.join(dir, 'notes.txt'), 'x');

    assert.deepEqual(await expandInputs([dir]), [bpmnPath]);

    const converted = await convertFile(bpmnPath);
    assert.equal(converted.output, path.join(dir, 'processus.drawio'));
    assert.equal(converted.pages, 2);

    // The original .bpmn is still there: restoring must not overwrite it.
    const restored = await convertFile(converted.output);
    assert.equal(restored.output, path.join(dir, 'processus (restauré).bpmn'));
    assert.equal(await readFile(restored.output, 'utf8'), await readFile(bpmnPath, 'utf8'));

    const out = path.join(dir, 'sortie');
    await (await import('node:fs/promises')).mkdir(out);
    assert.equal((await convertFile(bpmnPath, { outDir: out })).output, path.join(out, 'processus.drawio'));

    await assert.rejects(convertFile(path.join(dir, 'notes.txt')), /Format non reconnu/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
