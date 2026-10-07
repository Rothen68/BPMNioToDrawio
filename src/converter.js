// Converts BPMN 2.0 XML (as exported by bpmn.io / Camunda Modeler) into a
// draw.io (mxGraph) file, and restores the original BPMN from such a file.
//
// - Layout comes straight from the BPMN DI section, so the diagram looks the
//   same as in bpmn.io.
// - Shapes use draw.io's built-in BPMN 2.0 library, so they stay editable.
// - Each BPMNDiagram becomes a draw.io page (collapsed sub-processes with a
//   drill-down get their own page, linked from the sub-process shape).
// - The original BPMN XML is embedded (compressed) in the draw.io file, so it
//   can be extracted again without any loss with `extractBpmnFromDrawio`.

import BpmnModdle from 'bpmn-moddle';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const SOURCE_ATTRIBUTE = 'bpmnSource';
const SOURCE_PREFIX = 'deflate-base64:';
const CONVERTER_NAME = 'bpmn-to-drawio';

// ---------------------------------------------------------------------------
// Styles (taken from draw.io's "BPMN 2.0" shape library, Sidebar-BPMN.js)
// ---------------------------------------------------------------------------

const ACTIVITY_POINTS = 'points=[[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0.25,0],[1,0.5,0],[1,0.75,0],[0.75,1,0],[0.5,1,0],[0.25,1,0],[0,0.75,0],[0,0.5,0],[0,0.25,0]];';
const ACTIVITY = ACTIVITY_POINTS + 'shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=10;html=1;container=1;expand=0;collapsible=0;';
const EVENT = 'points=[[0.145,0.145,0],[0.5,0,0],[0.855,0.145,0],[1,0.5,0],[0.855,0.855,0],[0.5,1,0],[0.145,0.855,0],[0,0.5,0]];shape=mxgraph.bpmn.event;html=1;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;align=center;perimeter=ellipsePerimeter;outlineConnect=0;aspect=fixed;';
const GATEWAY = 'points=[[0.25,0.25,0],[0.5,0,0],[0.75,0.25,0],[1,0.5,0],[0.75,0.75,0],[0.5,1,0],[0.25,0.75,0],[0,0.5,0]];shape=mxgraph.bpmn.gateway2;html=1;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;align=center;perimeter=rhombusPerimeter;outlineConnect=0;';
const POOL = 'swimlane;html=1;startSize=30;fontStyle=0;collapsible=0;whiteSpace=wrap;';
const BLACK_BOX_POOL = 'rounded=0;whiteSpace=wrap;html=1;strokeWidth=2;';
const DATA_OBJECT = 'shape=mxgraph.bpmn.data2;labelPosition=center;verticalLabelPosition=bottom;align=center;verticalAlign=top;size=15;html=1;whiteSpace=wrap;';
const DATA_STORE = 'shape=datastore;html=1;labelPosition=center;verticalLabelPosition=bottom;align=center;verticalAlign=top;whiteSpace=wrap;';
const TEXT_ANNOTATION = 'shape=partialRectangle;html=1;whiteSpace=wrap;top=1;bottom=1;left=1;right=0;fillColor=none;align=left;verticalAlign=middle;spacingLeft=5;';
const GROUP = ACTIVITY_POINTS + 'rounded=1;arcSize=10;dashed=1;fillColor=none;gradientColor=none;dashPattern=8 3 1 3;strokeWidth=2;whiteSpace=wrap;html=1;verticalAlign=top;';

const EDGE = 'html=1;rounded=0;labelBackgroundColor=#ffffff;';
const SEQUENCE_FLOW = EDGE + 'endArrow=blockThin;endFill=1;endSize=6;';
const MESSAGE_FLOW = EDGE + 'dashed=1;dashPattern=8 4;endArrow=blockThin;endFill=0;startArrow=oval;startFill=0;endSize=6;startSize=4;';
const ASSOCIATION = EDGE + 'dashed=1;dashPattern=1 4;endFill=0;startFill=0;endSize=6;startSize=6;';

const TASK_MARKERS = {
  'bpmn:UserTask': 'user',
  'bpmn:ManualTask': 'manual',
  'bpmn:ServiceTask': 'service',
  'bpmn:SendTask': 'send',
  'bpmn:ReceiveTask': 'receive',
  'bpmn:ScriptTask': 'script',
  'bpmn:BusinessRuleTask': 'businessRule'
};

const EVENT_SYMBOLS = {
  'bpmn:MessageEventDefinition': 'message',
  'bpmn:TimerEventDefinition': 'timer',
  'bpmn:EscalationEventDefinition': 'escalation',
  'bpmn:ConditionalEventDefinition': 'conditional',
  'bpmn:LinkEventDefinition': 'link',
  'bpmn:ErrorEventDefinition': 'error',
  'bpmn:CancelEventDefinition': 'cancel',
  'bpmn:CompensateEventDefinition': 'compensation',
  'bpmn:SignalEventDefinition': 'signal',
  'bpmn:TerminateEventDefinition': 'terminate'
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert BPMN 2.0 XML into draw.io XML.
 *
 * @param {string} bpmnXml
 * @param {{ fileName?: string, embedSource?: boolean }} [options]
 * @returns {Promise<{ xml: string, pages: number, warnings: string[] }>}
 */
export async function convertBpmnToDrawio(bpmnXml, options = {}) {
  const { fileName = 'diagram.bpmn', embedSource = true } = options;
  const warnings = [];

  let definitions;
  try {
    const result = await new BpmnModdle().fromXML(bpmnXml);
    definitions = result.rootElement;
    for (const w of result.warnings || []) warnings.push(w.message);
  } catch (err) {
    throw new Error(`Fichier BPMN illisible : ${err.message}`);
  }

  const diagrams = definitions.diagrams || [];
  if (!diagrams.length || !diagrams.some((d) => d.plane?.planeElement?.length)) {
    throw new Error('Le fichier BPMN ne contient aucune information graphique (section BPMNDiagram vide).');
  }

  const index = buildSemanticIndex(definitions);

  // Page ids are needed upfront to link collapsed sub-processes to their page.
  const pageIdByPlaneOwner = new Map();
  diagrams.forEach((diagram, i) => {
    const owner = diagram.plane?.bpmnElement;
    if (owner && diagram.plane.planeElement?.length) pageIdByPlaneOwner.set(owner.id, pageId(i));
  });

  const pages = diagrams
    .filter((d) => d.plane?.planeElement?.length)
    .map((diagram, i) => {
      const ctx = { pageId: pageId(diagrams.indexOf(diagram)), index, pageIdByPlaneOwner, warnings };
      const root = i === 0 && embedSource ? { bpmnXml, fileName } : null;
      return renderPage(diagram, ctx, root, i === 0 ? baseName(fileName) : null);
    });

  const xml = `<mxfile host="${CONVERTER_NAME}" type="device">\n${pages.join('\n')}\n</mxfile>\n`;
  return { xml, pages: pages.length, warnings };
}

/**
 * Extract the original BPMN XML embedded by `convertBpmnToDrawio`.
 * Works on uncompressed draw.io files and on files re-saved (compressed) by draw.io.
 *
 * @param {string} drawioXml
 * @returns {{ bpmnXml: string, fileName: string | null } | null}
 */
export function extractBpmnFromDrawio(drawioXml) {
  const models = [];
  const diagramRe = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/g;
  let m;
  while ((m = diagramRe.exec(drawioXml))) {
    const content = m[1].trim();
    models.push(content.startsWith('<') ? content : decompressDiagram(content));
  }
  if (!models.length) models.push(drawioXml);

  for (const model of models) {
    const attrs = findSourceAttributes(model);
    if (attrs) return attrs;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Semantic index
// ---------------------------------------------------------------------------

function buildSemanticIndex(definitions) {
  const laneOfNode = new Map();
  const participantOfProcess = new Map();

  for (const root of definitions.rootElements || []) {
    if (is(root, 'bpmn:Collaboration')) {
      for (const p of root.participants || []) {
        if (p.processRef) participantOfProcess.set(p.processRef.id, p);
      }
    }
  }

  const visitLaneSet = (laneSet) => {
    for (const lane of laneSet?.lanes || []) {
      for (const node of lane.flowNodeRef || []) laneOfNode.set(node.id, lane);
      // Child lanes are visited after their parent, so the deepest lane wins.
      if (lane.childLaneSet) visitLaneSet(lane.childLaneSet);
    }
  };
  const visitContainer = (container) => {
    for (const laneSet of container.laneSets || []) visitLaneSet(laneSet);
    for (const el of container.flowElements || []) {
      if (el.flowElements) visitContainer(el);
    }
  };
  for (const root of definitions.rootElements || []) {
    if (is(root, 'bpmn:Process')) visitContainer(root);
  }

  return { laneOfNode, participantOfProcess };
}

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------

function renderPage(diagram, ctx, embedded, firstPageName) {
  const plane = diagram.plane;
  const layerId = `${ctx.pageId}-1`;
  const rootId = `${ctx.pageId}-0`;

  // Collect shapes of this plane.
  const shapes = new Map(); // element id -> shape info
  const edges = [];
  for (const di of plane.planeElement || []) {
    const el = di.bpmnElement;
    if (!el) {
      ctx.warnings.push(`Élément graphique ${di.id} sans élément BPMN associé, ignoré.`);
      continue;
    }
    if (is(di, 'bpmndi:BPMNShape') && di.bounds) {
      shapes.set(el.id, { di, el, abs: rect(di.bounds), parentId: null, cellId: el.id });
    } else if (is(di, 'bpmndi:BPMNEdge')) {
      edges.push({ di, el });
    }
  }

  // Resolve the container of every shape.
  for (const shape of shapes.values()) {
    const container = findContainer(shape.el, shapes, ctx.index);
    shape.parentId = container ? container.cellId : layerId;
  }

  const absOrigin = (cellId) => {
    const s = shapes.get(cellId);
    return s ? s.abs : { x: 0, y: 0, width: 0, height: 0 };
  };
  const depth = (shape) => {
    let d = 0;
    for (let p = shape; p && p.parentId !== layerId && d < 50; p = shapes.get(p.parentId)) d++;
    return d;
  };

  const cells = [];
  cells.push(
    embedded
      ? `<object label="" id="${rootId}" ${SOURCE_ATTRIBUTE}="${escapeAttr(compress(embedded.bpmnXml))}" bpmnFileName="${escapeAttr(embedded.fileName)}" convertedBy="${CONVERTER_NAME}"><mxCell /></object>`
      : `<mxCell id="${rootId}" />`
  );
  cells.push(`<mxCell id="${layerId}" parent="${rootId}" />`);

  // Vertices, containers first (stable order otherwise).
  const ordered = [...shapes.values()]
    .map((s, i) => ({ s, i, d: depth(s) }))
    .sort((a, b) => a.d - b.d || zRank(a.s.el) - zRank(b.s.el) || a.i - b.i)
    .map((x) => x.s);

  for (const shape of ordered) {
    const { style, label, link } = shapeStyle(shape, ctx);
    const origin = shape.parentId === layerId ? { x: 0, y: 0 } : absOrigin(shape.parentId);
    const g = shape.abs;
    cells.push(
      wrapObject(
        shape.cellId,
        { label, link, tooltip: documentationOf(shape.el), bpmnId: shape.el.id, bpmnType: shape.el.$type.replace('bpmn:', '') },
        `<mxCell style="${escapeAttr(style)}" vertex="1" parent="${shape.parentId}">` +
          `<mxGeometry x="${num(g.x - origin.x)}" y="${num(g.y - origin.y)}" width="${num(g.width)}" height="${num(g.height)}" as="geometry" />` +
          `</mxCell>`
      )
    );
  }

  // Edges.
  for (const { di, el } of edges) {
    const cell = renderEdge(di, el, shapes, layerId, absOrigin, ctx);
    if (cell) cells.push(cell);
  }

  const bounds = diagramBounds(shapes, edges);
  const owner = plane.bpmnElement;
  const name =
    diagram.name ||
    (is(owner, 'bpmn:SubProcess') ? owner.name || owner.id : firstPageName || owner?.name || ctx.pageId);

  return (
    `<diagram id="${ctx.pageId}" name="${escapeAttr(name)}">` +
    `<mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ` +
    `pageWidth="${Math.max(850, Math.ceil(bounds.maxX + 40))}" pageHeight="${Math.max(1100, Math.ceil(bounds.maxY + 40))}" math="0" shadow="0">` +
    `<root>\n${cells.join('\n')}\n</root></mxGraphModel></diagram>`
  );
}

// Lanes behind everything, then containers, then the rest.
function zRank(el) {
  if (is(el, 'bpmn:Lane')) return 0;
  if (is(el, 'bpmn:Group')) return 3;
  return 1;
}

/** Finds the shape (on this page) which should contain the given element. */
function findContainer(el, shapes, index) {
  const isContainerShape = (s) =>
    s && (is(s.el, 'bpmn:Participant') || is(s.el, 'bpmn:Lane') || (is(s.el, 'bpmn:SubProcess') && s.di.isExpanded));

  if (is(el, 'bpmn:Participant') || is(el, 'bpmn:Group')) return null;

  if (is(el, 'bpmn:Lane')) {
    const owner = el.$parent?.$parent; // LaneSet -> Lane | Process | SubProcess
    if (owner && is(owner, 'bpmn:Lane') && shapes.has(owner.id)) return shapes.get(owner.id);
    const participant = owner && index.participantOfProcess.get(owner.id);
    return participant ? shapes.get(participant.id) || null : null;
  }

  // Boundary events are children of their host activity (as in draw.io).
  if (is(el, 'bpmn:BoundaryEvent') && el.attachedToRef && shapes.has(el.attachedToRef.id)) {
    return shapes.get(el.attachedToRef.id);
  }

  let current = el;
  for (let parent = el.$parent; parent; current = parent, parent = parent.$parent) {
    if (is(parent, 'bpmn:SubProcess')) {
      // On the drill-down page of a collapsed sub-process, its children sit on the layer.
      const s = shapes.get(parent.id);
      return isContainerShape(s) ? s : null;
    }
    if (is(parent, 'bpmn:Process')) {
      const lane = index.laneOfNode.get(current.id);
      if (lane && shapes.has(lane.id)) return shapes.get(lane.id);
      const participant = index.participantOfProcess.get(parent.id);
      return participant && shapes.has(participant.id) ? shapes.get(participant.id) : null;
    }
    if (is(parent, 'bpmn:Collaboration') || is(parent, 'bpmn:Definitions')) return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shape styles
// ---------------------------------------------------------------------------

function shapeStyle(shape, ctx) {
  const { el, di } = shape;
  const label = toHtmlLabel(el.name);

  if (is(el, 'bpmn:Participant')) {
    // A "black box" pool (no process) has its name centered, as in bpmn.io.
    if (!el.processRef) return { style: BLACK_BOX_POOL, label };
    const horizontal = di.isHorizontal !== false;
    return { style: POOL + `horizontal=${horizontal ? 0 : 1};swimlaneLine=1;strokeWidth=2;`, label };
  }
  if (is(el, 'bpmn:Lane')) {
    const horizontal = di.isHorizontal !== false;
    return { style: POOL + `horizontal=${horizontal ? 0 : 1};swimlaneLine=1;`, label };
  }

  if (is(el, 'bpmn:Activity')) return activityStyle(shape, ctx, label);

  if (is(el, 'bpmn:Event')) return { style: EVENT + eventStyle(el) + externalLabelPosition(di), label };

  if (is(el, 'bpmn:Gateway')) return { style: GATEWAY + gatewayStyle(el, di) + externalLabelPosition(di), label };

  if (is(el, 'bpmn:DataObjectReference')) {
    const collection = el.dataObjectRef?.isCollection ? 'isCollection=1;' : '';
    return { style: DATA_OBJECT + collection, label };
  }
  if (is(el, 'bpmn:DataInput') || is(el, 'bpmn:DataOutput')) {
    const transfer = is(el, 'bpmn:DataInput') ? 'input' : 'output';
    return { style: DATA_OBJECT + `bpmnTransferType=${transfer};` + (el.isCollection ? 'isCollection=1;' : ''), label };
  }
  if (is(el, 'bpmn:DataStoreReference')) return { style: DATA_STORE, label };

  if (is(el, 'bpmn:TextAnnotation')) return { style: TEXT_ANNOTATION, label: toHtmlLabel(el.text) };

  if (is(el, 'bpmn:Group')) return { style: GROUP, label: toHtmlLabel(el.categoryValueRef?.value) };

  ctx.warnings.push(`Type non pris en charge (${el.$type}, id ${el.id}) : dessiné comme un rectangle.`);
  return { style: 'rounded=1;whiteSpace=wrap;html=1;dashed=1;', label: label || el.$type.replace('bpmn:', '') };
}

function activityStyle({ el, di }, ctx, label) {
  let style = ACTIVITY;
  let link;

  if (is(el, 'bpmn:SubProcess')) {
    const expanded = di.isExpanded === true;
    // In draw.io, bpmnShapeType=subprocess is the (dotted) event sub-process.
    if (is(el, 'bpmn:Transaction')) style += 'bpmnShapeType=transaction;';
    style += 'taskMarker=abstract;';
    if (el.triggeredByEvent) {
      style += 'bpmnShapeType=subprocess;';
      if (!expanded) {
        const start = (el.flowElements || []).find((f) => is(f, 'bpmn:StartEvent'));
        if (start) {
          const symbol = eventSymbol(start);
          style += `outline=${start.isInterrupting === false ? 'eventNonint' : 'eventInt'};symbol=${symbol};`;
        }
      }
    }
    if (is(el, 'bpmn:AdHocSubProcess')) style += 'isAdHoc=1;';
    if (expanded) {
      style += 'verticalAlign=top;align=left;spacingLeft=5;';
    } else {
      style += 'isLoopSub=1;';
      const target = ctx.pageIdByPlaneOwner.get(el.id);
      if (target && target !== ctx.pageId) link = `data:page/id,${target}`;
    }
  } else if (is(el, 'bpmn:CallActivity')) {
    style += 'bpmnShapeType=call;';
    style += di.isExpanded === true ? 'verticalAlign=top;align=left;spacingLeft=5;' : 'isLoopSub=1;';
  } else {
    style += `taskMarker=${TASK_MARKERS[el.$type] || 'abstract'};`;
  }

  const loop = el.loopCharacteristics;
  if (loop) {
    if (is(loop, 'bpmn:StandardLoopCharacteristics')) style += 'isLoopStandard=1;';
    else if (is(loop, 'bpmn:MultiInstanceLoopCharacteristics')) {
      style += loop.isSequential ? 'isLoopMultiSeq=1;' : 'isLoopMultiParallel=1;';
    }
  }
  if (el.isForCompensation) style += 'isLoopComp=1;';

  return { style, label, link };
}

// Events and gateways have their label outside the shape: below by default,
// above when bpmn.io placed it above.
function externalLabelPosition(di) {
  const b = di.label?.bounds;
  if (b && b.y + b.height / 2 < di.bounds.y) return 'verticalLabelPosition=top;verticalAlign=bottom;';
  return '';
}

function eventSymbol(el) {
  const defs = el.eventDefinitions || [];
  if (defs.length > 1) return el.parallelMultiple ? 'parallelMultiple' : 'multiple';
  if (defs.length === 1) return EVENT_SYMBOLS[defs[0].$type] || 'general';
  return 'general';
}

function eventStyle(el) {
  let symbol = eventSymbol(el);
  let outline;
  if (is(el, 'bpmn:StartEvent')) {
    const inEventSubProcess = el.$parent?.triggeredByEvent;
    outline = !inEventSubProcess ? 'standard' : el.isInterrupting === false ? 'eventNonint' : 'eventInt';
  } else if (is(el, 'bpmn:EndEvent')) {
    outline = 'end';
    if (symbol === 'general') symbol = 'terminate2';
  } else if (is(el, 'bpmn:IntermediateThrowEvent')) {
    outline = 'throwing';
  } else if (is(el, 'bpmn:BoundaryEvent')) {
    outline = el.cancelActivity === false ? 'boundNonint' : 'boundInt';
  } else {
    outline = 'catching';
  }
  return `outline=${outline};symbol=${symbol};`;
}

function gatewayStyle(el, di) {
  if (is(el, 'bpmn:ExclusiveGateway')) {
    return di.isMarkerVisible ? 'outline=none;symbol=none;gwType=exclusive;' : 'outline=none;symbol=none;';
  }
  if (is(el, 'bpmn:ParallelGateway')) return 'outline=none;symbol=none;gwType=parallel;';
  if (is(el, 'bpmn:InclusiveGateway')) return 'outline=end;symbol=general;';
  if (is(el, 'bpmn:ComplexGateway')) return 'outline=none;symbol=none;gwType=complex;';
  if (is(el, 'bpmn:EventBasedGateway')) {
    if (el.instantiate) {
      return el.eventGatewayType === 'Parallel' ? 'outline=standard;symbol=parallelMultiple;' : 'outline=standard;symbol=multiple;';
    }
    return 'outline=catching;symbol=multiple;';
  }
  return 'outline=none;symbol=none;';
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

function edgeEnds(el) {
  if (is(el, 'bpmn:DataInputAssociation')) {
    return { source: el.sourceRef?.[0], target: el.$parent };
  }
  if (is(el, 'bpmn:DataOutputAssociation')) {
    return { source: el.$parent, target: el.targetRef };
  }
  return { source: el.sourceRef, target: el.targetRef };
}

function edgeStyle(el) {
  if (is(el, 'bpmn:SequenceFlow')) {
    let style = SEQUENCE_FLOW;
    const source = el.sourceRef;
    if (source?.default === el) style += 'startArrow=dash;startFill=0;startSize=6;';
    else if (el.conditionExpression && is(source, 'bpmn:Activity')) style += 'startArrow=diamondThin;startFill=0;startSize=10;';
    return style;
  }
  if (is(el, 'bpmn:MessageFlow')) return MESSAGE_FLOW;
  if (is(el, 'bpmn:DataInputAssociation') || is(el, 'bpmn:DataOutputAssociation')) {
    return ASSOCIATION + 'endArrow=openThin;startArrow=none;';
  }
  if (is(el, 'bpmn:Association')) {
    const dir = el.associationDirection;
    return ASSOCIATION + `endArrow=${dir === 'One' || dir === 'Both' ? 'openThin' : 'none'};startArrow=${dir === 'Both' ? 'openThin' : 'none'};`;
  }
  return ASSOCIATION + 'endArrow=none;startArrow=none;';
}

function renderEdge(di, el, shapes, layerId, absOrigin, ctx) {
  const points = (di.waypoint || []).map((p) => ({ x: p.x, y: p.y }));
  if (points.length < 2) {
    ctx.warnings.push(`Liaison ${el.id} sans points de passage, ignorée.`);
    return null;
  }

  const ends = edgeEnds(el);
  const source = ends.source && shapes.get(ends.source.id);
  const target = ends.target && shapes.get(ends.target.id);

  // Place the edge in the nearest common container of its ends (like draw.io does),
  // so it moves together with the pool / sub-process.
  const ancestors = (shape) => {
    const list = [];
    for (let id = shape?.parentId; id && id !== layerId; id = shapes.get(id)?.parentId) list.push(id);
    list.push(layerId);
    return list;
  };
  let parentId = layerId;
  if (source && target) {
    const targetAncestors = new Set(ancestors(target));
    parentId = ancestors(source).find((id) => targetAncestors.has(id)) || layerId;
  } else if (source || target) {
    parentId = ancestors(source || target)[0];
  }
  const origin = parentId === layerId ? { x: 0, y: 0 } : absOrigin(parentId);
  const rel = (p) => `<mxPoint x="${num(p.x - origin.x)}" y="${num(p.y - origin.y)}"`;

  let style = edgeStyle(el);
  // Pin both ends exactly where bpmn.io drew them.
  const first = points[0];
  const last = points[points.length - 1];
  if (source) style += fixedPoint('exit', first, source.abs);
  if (target) style += fixedPoint('entry', last, target.abs);

  let geometry = `<mxGeometry relative="1" as="geometry">`;
  if (!source) geometry += `${rel(first)} as="sourcePoint" />`;
  if (!target) geometry += `${rel(last)} as="targetPoint" />`;
  const inner = points.slice(1, -1);
  if (inner.length) geometry += `<Array as="points">${inner.map((p) => `${rel(p)} />`).join('')}</Array>`;

  const label = toHtmlLabel(el.name);
  const labelBounds = di.label?.bounds;
  if (label && labelBounds) {
    const mid = polylineMidpoint(points);
    const cx = labelBounds.x + labelBounds.width / 2;
    const cy = labelBounds.y + labelBounds.height / 2;
    geometry += `<mxPoint x="${num(cx - mid.x)}" y="${num(cy - mid.y)}" as="offset" />`;
  }
  geometry += `</mxGeometry>`;

  const terminals = (source ? ` source="${source.cellId}"` : '') + (target ? ` target="${target.cellId}"` : '');
  return wrapObject(
    el.id,
    { label, tooltip: documentationOf(el), bpmnId: el.id, bpmnType: el.$type.replace('bpmn:', '') },
    `<mxCell style="${escapeAttr(style)}" edge="1" parent="${parentId}"${terminals}>${geometry}</mxCell>`
  );
}

function fixedPoint(prefix, point, bounds) {
  if (!bounds.width || !bounds.height) return '';
  const fx = clamp((point.x - bounds.x) / bounds.width);
  const fy = clamp((point.y - bounds.y) / bounds.height);
  return `${prefix}X=${num(fx, 4)};${prefix}Y=${num(fy, 4)};${prefix}Dx=0;${prefix}Dy=0;${prefix}Perimeter=0;`;
}

function polylineMidpoint(points) {
  const lengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(l);
    total += l;
  }
  let remaining = total / 2;
  for (let i = 1; i < points.length; i++) {
    const l = lengths[i - 1];
    if (remaining <= l && l > 0) {
      const t = remaining / l;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t
      };
    }
    remaining -= l;
  }
  return points[points.length - 1];
}

function diagramBounds(shapes, edges) {
  let maxX = 0;
  let maxY = 0;
  for (const { abs } of shapes.values()) {
    maxX = Math.max(maxX, abs.x + abs.width);
    maxY = Math.max(maxY, abs.y + abs.height);
  }
  for (const { di } of edges) {
    for (const p of di.waypoint || []) {
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { maxX, maxY };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function is(el, type) {
  return !!el && typeof el.$instanceOf === 'function' && el.$instanceOf(type);
}

function pageId(i) {
  return `page-${i + 1}`;
}

function baseName(fileName) {
  return String(fileName).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
}

function rect(b) {
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function clamp(v) {
  return Math.min(1, Math.max(0, v));
}

function num(v, decimals = 2) {
  return String(Number(v.toFixed(decimals)));
}

function documentationOf(el) {
  const docs = (el.documentation || []).map((d) => d.text).filter(Boolean);
  return docs.length ? docs.join('\n') : undefined;
}

function wrapObject(id, attrs, mxCell) {
  const parts = [`label="${escapeAttr(attrs.label || '')}"`];
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'label' || value === undefined || value === null || value === '') continue;
    parts.push(`${key}="${escapeAttr(value)}"`);
  }
  return `<object ${parts.join(' ')} id="${escapeAttr(id)}">${mxCell}</object>`;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Labels use html=1, so plain text is HTML-escaped and line breaks become <br>.
function toHtmlLabel(text) {
  if (!text) return '';
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
}

function unescapeAttr(value) {
  return value
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function compress(text) {
  return SOURCE_PREFIX + deflateRawSync(Buffer.from(text, 'utf8')).toString('base64');
}

function decompress(value) {
  if (!value.startsWith(SOURCE_PREFIX)) return value;
  return inflateRawSync(Buffer.from(value.slice(SOURCE_PREFIX.length), 'base64')).toString('utf8');
}

// draw.io's compressed format: base64(deflateRaw(encodeURIComponent(xml))).
function decompressDiagram(content) {
  try {
    const inflated = inflateRawSync(Buffer.from(content, 'base64')).toString('utf8');
    return decodeURIComponent(inflated);
  } catch {
    return '';
  }
}

function findSourceAttributes(model) {
  const tagRe = /<(?:object|UserObject)\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(model))) {
    const tag = m[0];
    const source = tag.match(new RegExp(`\\s${SOURCE_ATTRIBUTE}="([^"]*)"`));
    if (!source) continue;
    const fileName = tag.match(/\sbpmnFileName="([^"]*)"/);
    return {
      bpmnXml: decompress(unescapeAttr(source[1])),
      fileName: fileName ? unescapeAttr(fileName[1]) : null
    };
  }
  return null;
}
