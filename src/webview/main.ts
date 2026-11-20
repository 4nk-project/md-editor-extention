import { EditorState, TextSelection, NodeSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark, setBlockType, wrapIn, chainCommands, exitCode } from 'prosemirror-commands';
import { wrapInList, splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { schema, parseMarkdown, serializeMarkdown } from '../core/markdown';
import type { Field, FieldPatch } from '../core/article';
declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): any; setState(state: any): void };
const vscode = acquireVsCodeApi();
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<header><div class="brand"><span class="brand-icon">M<span>↓</span></span><div><strong>記事エディター</strong><span id="filename">Markdown</span></div></div><div class="header-actions"><span id="status" role="status">読み込み中…</span><button id="source" class="quiet">〈/〉 ソースを開く</button></div></header>
<nav id="toolbar" aria-label="本文の書式"><select id="block" aria-label="段落・見出し"><option value="p">段落</option>${[1,2,3,4,5,6].map(n=>`<option value="${n}">見出し ${n}</option>`).join('')}</select><span class="separator"></span><button data-action="bold" title="太字（⌘/Ctrl+B）" aria-label="太字"><b>B</b></button><button data-action="italic" title="斜体（⌘/Ctrl+I）" aria-label="斜体"><i>I</i></button><button data-action="inlineCode" title="インラインコード" aria-label="インラインコード">&lt;/&gt;</button><button data-action="link" title="リンク" aria-label="リンク">↗</button><span class="separator"></span><button data-action="bullet" title="箇条書き" aria-label="箇条書き">• ≡</button><button data-action="ordered" title="番号付きリスト" aria-label="番号付きリスト">1. ≡</button><button data-action="quote" title="引用" aria-label="引用">❞</button><button data-action="code" title="コードブロック" aria-label="コードブロック">{ }</button><button data-action="hr" title="水平線" aria-label="水平線">―</button><span class="separator"></span><button data-action="image" class="image-button" title="ローカル画像を挿入">▧ 画像</button><button data-action="imageUrl" title="画像URL・代替テキストの編集">画像URL / 説明</button><input id="language" aria-label="コードブロックの言語" placeholder="コードの言語" hidden></nav>
<main><div id="notice" role="alert" hidden></div><details id="metadata" open><summary><span>記事情報</span><span class="summary-hint">FRONTMATTER</span></summary><div id="fields"></div><p class="form-help">未設定の項目は、入力するまでファイルに追加されません。</p></details><section class="body-section"><div class="section-label"><span>本文</span><span>MARKDOWN</span></div><div id="editor"></div><pre id="readonly-source" hidden></pre></section><details id="recovery" hidden><summary>競合前の入力を確認・コピー</summary><p>外部の変更を優先して再同期しました。以下の入力は自動適用されません。</p><textarea aria-label="競合前の入力" readonly></textarea></details><footer><span>Astro Markdown</span><span>通常の保存操作で .md に保存</span></footer></main>
<dialog id="input-dialog"><form method="dialog"><h2 id="dialog-title"></h2><div id="dialog-fields"></div><div class="dialog-actions"><button value="cancel">キャンセル</button><button id="dialog-submit" value="ok" class="primary">適用</button></div></form></dialog>`;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
let state: any;
let view: EditorView | undefined;
let id = 0;
let inFlight: { id: number; body?: string; patches: FieldPatch[] } | undefined;
let dirtyBody = false;
let pending = new Map<string, FieldPatch>();
let timer: ReturnType<typeof setTimeout>;
let composing = false;
let deferred: any[] = [];
let actionAfter: string | undefined;
let saveToken: number | undefined;
let images: Record<string,string> = {};
let imageRequests = new Map<number, { pos: number; version: number }>();
let errorLocked = false;
let recoveryText: string | undefined;
const status = (text: string) => { $('#status').textContent = text; };
function remember() {
  // Keep unsent content across webview reloads; never silently replay it over a newer document.
  vscode.setState({ recovery: dirtyBody || pending.size || inFlight ? JSON.stringify({ body: view && serializeMarkdown(view.state.doc), fields: [...pending.values()], sent: inFlight }) : recoveryText, metadataOpen: $('#metadata').hasAttribute('open') });
}
function schedule() { clearTimeout(timer); remember(); status('変更を反映中…'); if (state && !state.dirty && !composing && !view?.composing) flush(); else timer = setTimeout(flush, 350); }
function flush() {
  clearTimeout(timer);
  if (!state || composing || view?.composing || inFlight || errorLocked || state.readOnly) return;
  if (!dirtyBody && !pending.size) {
    if (saveToken !== undefined) { vscode.postMessage({ type: 'flushed', token: saveToken }); saveToken = undefined; }
    if (actionAfter) { const type = actionAfter; actionAfter = undefined; vscode.postMessage({ type }); }
    return;
  }
  inFlight = { id: ++id, body: dirtyBody && view ? serializeMarkdown(view.state.doc) : undefined, patches: [...pending.values()] };
  dirtyBody = false; pending.clear(); remember();
  vscode.postMessage({ type: 'edit', version: state.version, ...inFlight });
}
function afterFlush(type: string) { actionAfter = type; flush(); }
function recovery(text: string) { recoveryText = text; $('#recovery').hidden = false; $('#recovery textarea').textContent = text; ($<HTMLTextAreaElement>('#recovery textarea')).value = text; }
const prior = vscode.getState();
if (prior?.recovery) recovery(prior.recovery);
if (prior?.metadataOpen === false) $('#metadata').removeAttribute('open');
$('#metadata').addEventListener('toggle', remember);
function renderFields() {
  const root = $('#fields'); root.replaceChildren();
  for (const field of state.fields as Field[]) {
    const item = state.values[field.key];
    const wrap = document.createElement('div'); wrap.className = 'field' + (field.type === 'multiline' ? ' wide' : '');
    const label = document.createElement('label'); label.textContent = field.label; label.htmlFor = 'field-' + field.key;
    const value = document.createElement(field.type === 'multiline' || field.type === 'stringArray' ? 'textarea' : field.type === 'boolean' ? 'select' : 'input') as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    value.id = label.htmlFor;
    if (value instanceof HTMLSelectElement) for (const [v,t] of [['','未設定'],['true','はい（true）'],['false','いいえ（false）']]) { const option = document.createElement('option'); option.value = v; option.textContent = t; value.append(option); }
    if (value instanceof HTMLInputElement) {
      value.type = field.type === 'date' && (!item.present || /^\d{4}-\d{2}-\d{2}$/.test(item.value)) ? 'date' : 'text';
      // Timestamp strings are intentionally shown verbatim rather than truncated by a date input.
    }
    value.value = item.present && item.value !== undefined ? Array.isArray(item.value) ? item.value.join('\n') : String(item.value) : '';
    value.disabled = state.readOnly || !!item.error || errorLocked;
    const note = document.createElement('small'); note.textContent = item.error ?? (item.present ? '設定済み' : '未設定');
    const remove = document.createElement('button'); remove.textContent = '未設定に戻す'; remove.className = 'unset'; remove.disabled = value.disabled || !item.present;
    const change = (patch: FieldPatch) => { pending.set(field.key, patch); note.textContent = patch.remove ? '未設定に変更' : '変更あり'; remove.disabled = !!patch.remove; schedule(); };
    value.addEventListener('input', () => {
      if (field.type === 'boolean' && value.value === '') { change({ key: field.key, remove: true }); return; }
      change({ key: field.key, value: field.type === 'boolean' ? value.value === 'true' : field.type === 'stringArray' ? value.value.split('\n').filter(s => s.length > 0) : value.value });
    });
    value.addEventListener('compositionstart', () => { composing = true; });
    value.addEventListener('compositionend', finishComposition);
    value.addEventListener('blur', flush);
    remove.addEventListener('click', () => { value.value = ''; change({ key: field.key, remove: true }); });
    const row = document.createElement('div'); row.className = 'field-note'; row.append(note, remove);
    wrap.append(label, value, row); root.append(wrap);
  }
}
function finishComposition() {
  composing = false;
  setTimeout(() => {
    if (composing || view?.composing) { setTimeout(finishComposition, 30); return; }
    const messages = deferred; deferred = []; messages.forEach(receive); flush();
  }, 30);
}
function makeState(body: string) {
  return EditorState.create({ doc: parseMarkdown(body), plugins: [keymap({
    'Mod-b': toggleMark(schema.marks.strong), 'Mod-i': toggleMark(schema.marks.em), 'Mod-`': toggleMark(schema.marks.code),
    Enter: splitListItem(schema.nodes.list_item), Tab: sinkListItem(schema.nodes.list_item), 'Shift-Tab': liftListItem(schema.nodes.list_item),
    'Mod-Enter': chainCommands(exitCode, (s,d) => { if(d) d(s.tr.insert(s.selection.to, schema.nodes.paragraph.create()).scrollIntoView()); return true; }),
  }), keymap(baseKeymap)] });
}
function buildEditor(body: string) {
  if (view) { view.updateState(makeState(body)); view.setProps({ editable: () => !state.readOnly && !errorLocked }); return; }
  view = new EditorView($('#editor'), {
    state: makeState(body), editable: () => !state.readOnly && !errorLocked,
    attributes: { 'aria-label': '記事本文', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'false' },
    dispatchTransaction(tr) {
      if (!view) return;
      view.updateState(view.state.apply(tr));
      if (tr.docChanged) { dirtyBody = true; schedule(); }
      updateToolbar();
    },
    handleDOMEvents: {
      compositionstart: () => { composing = true; return false; },
      compositionend: () => { finishComposition(); return false; },
      blur: () => { flush(); return false; },
      dragover: (_v, e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); return true; } return false; },
      drop: (v, e) => {
        if (!e.dataTransfer?.files.length) return false;
        e.preventDefault();
        if (state.readOnly || errorLocked) return true;
        const pos = v.posAtCoords({ left:e.clientX, top:e.clientY })?.pos;
        if (pos !== undefined) v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(pos))));
        const files = [...e.dataTransfer.files];
        if (files.length !== 1) { status('画像は1枚ずつドロップしてください。'); return true; }
        void dropFile(files[0]); return true;
      },
    },
    handleClick: (_v, _pos, event) => { if ((event.target as HTMLElement).closest('a')) event.preventDefault(); return false; },
    handleClickOn: (_v, _pos, node, nodePos, event) => { if (node.type === schema.nodes.image && event.detail === 2) { view!.dispatch(view!.state.tr.setSelection(NodeSelection.create(view!.state.doc, nodePos))); void imageDialog(); return true; } return false; },
    nodeViews: {
      image(node) {
        const dom = document.createElement('span'); dom.className = 'article-image'; dom.contentEditable = 'false';
        const img = document.createElement('img'); img.alt = node.attrs.alt ?? ''; img.title = node.attrs.title ?? ''; img.draggable = false;
        const caption = document.createElement('span'); caption.className = 'image-caption'; caption.textContent = `${node.attrs.alt || '代替テキストなし'} · ${node.attrs.src}`;
        const src = images[node.attrs.src] ?? (/^https:\/\//i.test(node.attrs.src) ? node.attrs.src : undefined);
        if (src) { img.src = src; img.addEventListener('error', () => { img.hidden = true; dom.classList.add('missing'); }); } else { img.hidden = true; dom.classList.add('missing'); }
        dom.append(img, caption); return { dom };
      },
    },
  });
  updateToolbar();
}
function updateToolbar() {
  if (!view) return;
  const parent = view.state.selection.$from.parent;
  $<HTMLSelectElement>('#block').value = parent.type === schema.nodes.heading ? String(parent.attrs.level) : 'p';
  const language = $<HTMLInputElement>('#language'); language.hidden = parent.type !== schema.nodes.code_block;
  if (document.activeElement !== language) language.value = parent.attrs.params ?? '';
  for (const [action,mark] of [['bold','strong'],['italic','em'],['inlineCode','code']]) {
    const marks = view.state.storedMarks ?? view.state.selection.$from.marks();
    const active = !!schema.marks[mark].isInSet(marks);
    $(`[data-action="${action}"]`).setAttribute('aria-pressed', String(active));
  }
}
function applySnapshot(next: any, conflict = false) {
  const changed = state && next.text !== state.text;
  if ((conflict || changed) && (dirtyBody || pending.size || inFlight)) recovery(JSON.stringify({ body: view && serializeMarkdown(view.state.doc), fields: [...pending.values()], sent: inFlight }, null, 2));
  state = next; images = next.images; dirtyBody = false; pending.clear(); inFlight = undefined; errorLocked = false; imageRequests.clear();
  $('#filename').textContent = state.filename;
  const reason = state.error || (!state.trusted ? '未信頼ワークスペースのため読み取り専用です。VS Codeで信頼を設定すると編集できます。' : '');
  $('#notice').textContent = reason; $('#notice').hidden = !reason;
  $('#readonly-source').hidden = !state.error; $('#editor').hidden = !!state.error;
  $('#readonly-source').textContent = state.body;
  if (!state.error) buildEditor(state.body);
  renderFields();
  for (const el of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('#toolbar button, #toolbar select, #toolbar input')) el.disabled = state.readOnly;
  status(conflict ? '変更を再同期しました' : state.readOnly ? '読み取り専用' : '編集できます'); remember();
}
function receive(message: any) {
  if (message.type === 'flushForSave') {
    if (composing || view?.composing || state?.readOnly || errorLocked) vscode.postMessage({ type: 'flushed', token: message.token });
    else { saveToken = message.token; flush(); }
  } else if (message.type === 'ack') {
    if (message.id !== inFlight?.id) return;
    state = message.state; images = state.images; inFlight = undefined; remember();
    status('文書に反映済み'); flush();
  } else if (message.type === 'state' || message.type === 'conflict') {
    // Do not reset the editor on redundant messages: selection and IME DOM stay intact.
    if (message.type === 'state' && state && message.state.version < state.version) return;
    if (message.type === 'state' && state && message.state.text === state.text && message.state.trusted === state.trusted && JSON.stringify(message.state.fields) === JSON.stringify(state.fields)) { state.version = Math.max(state.version, message.state.version); state.dirty = message.state.dirty; return; }
    actionAfter = undefined; applySnapshot(message.state, message.type === 'conflict');
  } else if (message.type === 'error') {
    if (message.id === inFlight?.id) {
      recovery(JSON.stringify({ body: view && serializeMarkdown(view.state.doc), fields: [...pending.values()], sent: inFlight }, null, 2));
      errorLocked = true; inFlight = undefined; view?.setProps({ editable: () => false });
      document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('#fields input, #fields select, #fields textarea, #fields button, #toolbar button, #toolbar input, #toolbar select').forEach(e => e.disabled = true);
    }
    imageRequests.delete(message.id);
    $('#notice').hidden = false; $('#notice').textContent = message.message; status('操作を完了できませんでした');
  } else if (message.type === 'image') {
    const request = imageRequests.get(message.id); imageRequests.delete(message.id);
    if (!request || request.version !== state.version || message.version !== state.version || !view || state.readOnly || dirtyBody || pending.size || inFlight) { status('文書が変更されたため画像の挿入を中止しました。'); return; }
    images[message.src] = message.display;
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(Math.min(request.pos, view.state.doc.content.size)))));
    void imageDialog(message.src);
  } else if (message.type === 'imageCancelled') imageRequests.delete(message.id);
}
window.addEventListener('message', e => {
  if (e.data.type === 'flushForSave') { receive(e.data); return; }
  if (composing || view?.composing) deferred.push(e.data); else receive(e.data);
});
function run(command: Command) { if (view && !state.readOnly && !errorLocked) { command(view.state, view.dispatch, view); view.focus(); updateToolbar(); } }
function ask(title: string, entries: { name: string; label: string; value: string }[]): Promise<Record<string,string> | undefined> {
  const dialog = $<HTMLDialogElement>('#input-dialog'); $('#dialog-title').textContent = title;
  const root = $('#dialog-fields'); root.replaceChildren();
  for (const entry of entries) {
    const label = document.createElement('label'); label.textContent = entry.label;
    const input = document.createElement('input'); input.name = entry.name; input.value = entry.value; label.append(input); root.append(label);
  }
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? Object.fromEntries(entries.map(entry=>[entry.name, ($<HTMLInputElement>(`#dialog-fields input[name="${entry.name}"]`)).value])) : undefined), { once:true }));
}
async function imageDialog(src = '') {
  if (!view || state.readOnly || errorLocked) return;
  const originalDoc = view.state.doc;
  const selected = view.state.selection instanceof NodeSelection && view.state.selection.node.type === schema.nodes.image ? view.state.selection.node : undefined;
  const result = await ask('画像と代替テキスト', [{ name:'src',label:'画像パス / HTTPS URL',value:src || selected?.attrs.src || '' },{name:'alt',label:'代替テキスト（画像の説明）',value:selected?.attrs.alt || ''}]);
  if (!result || !result.src || !view || state.readOnly || errorLocked) return;
  if (view.state.doc !== originalDoc) { status('文書が変更されたため画像の挿入を中止しました。'); return; }
  if (/^[a-z][a-z\d+.-]*:/i.test(result.src) && !/^https:\/\//i.test(result.src)) { status('外部画像はHTTPS URLを使用してください。'); return; }
  if (selected) view.dispatch(view.state.tr.setNodeMarkup(view.state.selection.from, undefined, { ...selected.attrs, ...result }));
  else view.dispatch(view.state.tr.replaceSelectionWith(schema.nodes.image.create({ ...result, title: null })).scrollIntoView());
  view.focus();
}
async function linkDialog() {
  if (!view) return;
  const originalDoc = view.state.doc;
  const mark = schema.marks.link.isInSet(view.state.selection.$from.marks());
  const result = await ask('リンク', [{name:'href',label:'URL（空にするとリンク解除）',value:mark?.attrs.href ?? ''}]);
  if (!result || !view || state.readOnly || errorLocked) return;
  if (view.state.doc !== originalDoc) { status('文書が変更されたためリンクの編集を中止しました。'); return; }
  if (result.href && !/^(https?:|mailto:|#|\.?\.?\/)/i.test(result.href)) { status('HTTP・HTTPS・mailto・相対URLを指定してください。'); return; }
  const { from, to } = view.state.selection;
  let tr = view.state.tr.removeMark(from, to, schema.marks.link);
  if (result.href) {
    if (from === to) tr = tr.insertText(result.href).addMark(from, from + result.href.length, schema.marks.link.create({ href:result.href }));
    else tr = tr.addMark(from,to,schema.marks.link.create({href:result.href}));
  }
  view.dispatch(tr); view.focus();
}
function requestImage(data?: string) {
  if (!view || state.readOnly || errorLocked || inFlight || dirtyBody || pending.size) { status('変更の反映が完了してから画像を追加してください。'); flush(); return; }
  const requestId = ++id; imageRequests.set(requestId, { pos:view.state.selection.from,version:state.version });
  vscode.postMessage({ type:'image',id:requestId,version:state.version,data });
}
async function dropFile(file: File) {
  if (file.size > 20 * 1024 * 1024) { status('画像は20MB以下にしてください。'); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = ''; for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
  requestImage(btoa(binary));
}
const commands: Record<string,()=>void> = {
  bold:()=>run(toggleMark(schema.marks.strong)), italic:()=>run(toggleMark(schema.marks.em)), inlineCode:()=>run(toggleMark(schema.marks.code)),
  bullet:()=>run(wrapInList(schema.nodes.bullet_list)), ordered:()=>run(wrapInList(schema.nodes.ordered_list)), quote:()=>run(wrapIn(schema.nodes.blockquote)),
  code:()=>run(setBlockType(schema.nodes.code_block, {params:''})), hr:()=>run((s,d)=>{ if(d) d(s.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create()).scrollIntoView()); return true; }),
  link:()=>void linkDialog(), image:()=>requestImage(), imageUrl:()=>void imageDialog(),
};
$('#toolbar').addEventListener('mousedown', e => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); });
$('#toolbar').addEventListener('click', e => { const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]'); if (button && !button.disabled) commands[button.dataset.action!]?.(); });
$('#block').addEventListener('change', e => { const value = (e.target as HTMLSelectElement).value; run(value === 'p' ? setBlockType(schema.nodes.paragraph) : setBlockType(schema.nodes.heading,{level:Number(value)})); });
$('#language').addEventListener('input', e => { if (!view) return; const parent = view.state.selection.$from; if (parent.parent.type === schema.nodes.code_block) view.dispatch(view.state.tr.setNodeMarkup(parent.before(),undefined,{params:(e.target as HTMLInputElement).value})); });
$('#source').addEventListener('click', () => { if (errorLocked || state?.readOnly) vscode.postMessage({type:'source'}); else afterFlush('source'); });
window.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey) || e.isComposing || composing || view?.composing || $('#input-dialog').hasAttribute('open')) return;
  if (e.key.toLowerCase() === 's') { e.preventDefault(); afterFlush('save'); }
  if (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y') { e.preventDefault(); afterFlush(e.shiftKey || e.key.toLowerCase() === 'y' ? 'redo' : 'undo'); }
}, true);
window.addEventListener('blur', flush);
vscode.postMessage({type:'ready'});
