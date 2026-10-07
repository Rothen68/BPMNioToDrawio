// Window logic: file list, destination choice and conversion progress.
// `api` is the global exposed by preload.cjs.

const $ = (id) => document.getElementById(id);
const drop = $('drop');
const list = $('list');
const convertBtn = $('convert');
const clearBtn = $('clear');
const folderBtn = $('folder');
const folderPath = $('folder-path');
const summary = $('summary');

/** @type {{ path: string, state: 'pending'|'busy'|'done'|'warn'|'error', detail?: string, output?: string }[]} */
let items = [];
let outDir = null;
let running = false;

const ACCEPTED = /\.(bpmn|bpmn20\.xml|drawio)$/i;

function fileName(p) {
  return p.split(/[\\/]/).pop();
}

function addFiles(paths) {
  const known = new Set(items.map((i) => i.path));
  let rejected = 0;
  for (const p of paths) {
    if (!p) continue;
    if (!ACCEPTED.test(p)) {
      rejected++;
      continue;
    }
    if (!known.has(p)) {
      items.push({ path: p, state: 'pending' });
      known.add(p);
    }
  }
  summary.textContent = rejected ? `${rejected} fichier(s) ignoré(s) : seuls .bpmn et .drawio sont acceptés.` : '';
  render();
}

function render() {
  list.replaceChildren(
    ...items.map((item, index) => {
      const li = document.createElement('li');
      li.className = item.state;

      const icon = document.createElement('span');
      icon.className = 'status-icon';
      icon.textContent = { pending: '•', busy: '…', done: '✓', warn: '⚠', error: '✗' }[item.state];

      const name = document.createElement('div');
      name.className = 'name';
      const file = document.createElement('div');
      file.className = 'file';
      file.textContent = fileName(item.path);
      file.title = item.path;
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent =
        item.detail || (/\.drawio$/i.test(item.path) ? 'Restaurer le BPMN d’origine' : 'En attente');
      detail.title = detail.textContent;
      name.append(file, detail);

      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'link';
      show.textContent = 'Afficher';
      show.hidden = !item.output;
      show.addEventListener('click', () => api.showItem(item.output));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn';
      remove.title = 'Retirer de la liste';
      remove.textContent = '×';
      remove.disabled = running;
      remove.addEventListener('click', () => {
        items.splice(index, 1);
        render();
      });

      li.append(icon, name, show, remove);
      return li;
    })
  );

  $('count').textContent = items.length ? `${items.length} fichier(s)` : 'Aucun fichier';
  clearBtn.hidden = !items.length || running;
  const destOk = destination() !== 'folder' || outDir;
  convertBtn.disabled = running || !destOk || !items.some((i) => i.state === 'pending' || i.state === 'error');
}

function destination() {
  return document.querySelector('input[name="dest"]:checked').value;
}

async function convertAll() {
  running = true;
  summary.textContent = '';
  const targets = items.filter((i) => i.state === 'pending' || i.state === 'error');
  render();

  let ok = 0;
  for (const item of targets) {
    item.state = 'busy';
    item.detail = 'Conversion…';
    render();
    const result = await api.convert(item.path, destination() === 'folder' ? outDir : null);
    if (result.ok) {
      ok++;
      item.output = result.output;
      const what = result.mode === 'restore' ? 'BPMN restauré' : `${result.pages} page(s)`;
      if (result.warnings.length) {
        item.state = 'warn';
        item.detail = `${fileName(result.output)} — ${what} — ${result.warnings.join(' ; ')}`;
      } else {
        item.state = 'done';
        item.detail = `${fileName(result.output)} — ${what}`;
      }
    } else {
      item.state = 'error';
      item.detail = result.error;
    }
    render();
  }

  running = false;
  summary.textContent = `${ok}/${targets.length} fichier(s) converti(s).`;
  render();
}

// Drag & drop anywhere in the window.
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) drop.classList.remove('over');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (running) return;
  addFiles([...e.dataTransfer.files].map((f) => api.pathForFile(f)));
});

$('pick').addEventListener('click', async () => addFiles(await api.openFiles()));
drop.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' || e.key === ' ') addFiles(await api.openFiles());
});
clearBtn.addEventListener('click', () => {
  items = [];
  summary.textContent = '';
  render();
});
folderBtn.addEventListener('click', async () => {
  const folder = await api.chooseFolder();
  if (folder) {
    outDir = folder;
    folderPath.textContent = folder;
    folderPath.title = folder;
    document.querySelector('input[name="dest"][value="folder"]').checked = true;
  }
  render();
});
document.querySelectorAll('input[name="dest"]').forEach((r) => r.addEventListener('change', render));
convertBtn.addEventListener('click', convertAll);
api.onFilesAdded(addFiles);

render();
