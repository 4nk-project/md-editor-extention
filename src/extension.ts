import * as vscode from 'vscode';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { defaultFields, inspectArticle, minimalChange, updateArticle, validFields, validPatch, type Field } from './core/article';
import { parseMarkdown } from './core/markdown';
import { copyImage, inside, MAX_IMAGE_BYTES, readImage } from './core/images';
const VIEW = 'astroMarkdown.visualEditor';
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('astroMarkdown.openVisualEditor', async (uri?: vscode.Uri) => {
    uri ??= vscode.window.activeTextEditor?.document.uri;
    if (!uri || path.extname(uri.fsPath) !== '.md') { void vscode.window.showInformationMessage('Markdown（.md）ファイルを選択してください。'); return; }
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW);
  }), vscode.window.registerCustomEditorProvider(VIEW, new ArticleProvider(context), { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
}
class ArticleProvider implements vscode.CustomTextEditorProvider {
  constructor(private context: vscode.ExtensionContext) {}
  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const resourceRoot = folder?.uri ?? vscode.Uri.file(path.dirname(document.uri.fsPath));
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), resourceRoot] };
    const config = () => vscode.workspace.getConfiguration('astroMarkdown', document.uri);
    const fields = (): Field[] => { const f = config().get('fields', defaultFields); return validFields(f) ? f : defaultFields; };
    let disposed = false, applying = false;
    let queue = Promise.resolve();
    let saveId = 0;
    const saveWaiters = new Map<number, () => void>();
    const snapshot = async () => {
      const text = document.getText(), version = document.version, fs = fields();
      const article = inspectArticle(text, fs);
      const images: Record<string, string> = Object.create(null);
      if (!article.error) {
        const refs = new Set<string>();
        parseMarkdown(article.body).descendants(n => { if (n.type.name === 'image') refs.add(n.attrs.src); });
        await Promise.all([...refs].map(async src => {
          if (/^https:\/\//i.test(src)) { images[src] = src; return; }
          if (/^[a-z][a-z\d+.-]*:|^[/\\]|^#/i.test(src)) return;
          try {
            const file = path.resolve(path.dirname(document.uri.fsPath), decodeURIComponent(src));
            const [rootReal, fileReal] = await Promise.all([realpath(resourceRoot.fsPath), realpath(file)]);
            if (inside(rootReal, fileReal)) images[src] = webview.asWebviewUri(vscode.Uri.file(fileReal)).toString();
          } catch { /* Missing images show the original reference and alt. */ }
        }));
      }
      return { text, version, dirty: document.isDirty, body: article.body, fields: fs, values: article.values, images, error: article.error, readOnly: !vscode.workspace.isTrusted || !!article.error, trusted: vscode.workspace.isTrusted, filename: path.basename(document.uri.fsPath) };
    };
    const send = async (type = 'state', extra = {}) => { const state = await snapshot(); if (!disposed) await webview.postMessage({ type, state, ...extra }); };
    const subscriptions: vscode.Disposable[] = [];
    subscriptions.push(vscode.workspace.onDidSaveTextDocument(saved => { if (saved.uri.toString() === document.uri.toString()) void send(); }), vscode.workspace.onDidChangeTextDocument(e => { if (e.document.uri.toString() === document.uri.toString() && !applying) void send(); }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('astroMarkdown', document.uri)) void send(); }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void send()),
      vscode.workspace.onWillSaveTextDocument(event => {
        if (event.document.uri.toString() !== document.uri.toString()) return;
        const token = ++saveId;
        event.waitUntil(new Promise<void>(resolve => {
          const timeout = setTimeout(() => { saveWaiters.delete(token); resolve(); }, 1200);
          saveWaiters.set(token, () => { clearTimeout(timeout); resolve(); });
          void webview.postMessage({ type: 'flushForSave', token });
        }));
      }));
    const handle = async (message: any) => {
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      if (message.type === 'ready') { await send(); return; }
      if (message.type === 'source') { await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'); return; }
      if (message.type === 'flushed' && Number.isInteger(message.token)) { saveWaiters.get(message.token)?.(); saveWaiters.delete(message.token); return; }
      if (message.type === 'save') { void document.save().then(undefined, error => vscode.window.showErrorMessage(String(error))); return; }
      if (message.type === 'undo' || message.type === 'redo') { await vscode.commands.executeCommand(message.type); return; }
      if (!vscode.workspace.isTrusted) { await send(); return; }
      if (message.type === 'edit') {
        if (!Number.isInteger(message.version) || !Number.isInteger(message.id) || (message.body !== undefined && (typeof message.body !== 'string' || message.body.length > 10_000_000)) || !Array.isArray(message.patches) || message.patches.length > 100 || !message.patches.every((p: unknown) => validPatch(p, fields()))) return;
        if (message.version !== document.version) { await send('conflict', { id: message.id }); return; }
        const before = document.getText();
        const after = updateArticle(before, fields(), message.body, message.patches);
        if (before !== after) {
          const change = minimalChange(before, after);
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)), change.text);
          // No await between version check and submission. VS Code applies this edit against its document model.
          if (message.version !== document.version) { await send('conflict', { id: message.id }); return; }
          applying = true;
          try { if (!await vscode.workspace.applyEdit(edit)) throw new Error('文書への変更を適用できませんでした。'); }
          finally { applying = false; }
        }
        if (document.getText() !== after) await send('conflict', { id: message.id });
        else await send('ack', { id: message.id });
        return;
      }
      if (message.type === 'image') {
        if (!Number.isInteger(message.id) || !Number.isInteger(message.version)) return;
        if (message.version !== document.version || inspectArticle(document.getText(), fields()).error) { await send('conflict', { id: message.id }); return; }
        if (!folder || folder.uri.scheme !== 'file') throw new Error('画像の追加にはローカルのワークスペースを開いてください。');
        let bytes: Uint8Array;
        if (message.data !== undefined) {
          if (typeof message.data !== 'string' || message.data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) throw new Error('画像データが不正です。');
          bytes = Buffer.from(message.data, 'base64');
        } else {
          const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { '画像': ['png', 'jpg', 'jpeg', 'webp', 'gif'] } });
          if (!files?.length) { await webview.postMessage({ type: 'imageCancelled', id: message.id }); return; }
          if ((await stat(files[0].fsPath)).size > MAX_IMAGE_BYTES) throw new Error('画像は20MB以下にしてください。');
          bytes = await readImage(files[0].fsPath);
        }
        if (!vscode.workspace.isTrusted || message.version !== document.version) { await send('conflict', { id: message.id }); return; }
        const ref = await copyImage(folder.uri.fsPath, document.uri.fsPath, config().get('imageDirectory', 'assets/{name}'), bytes);
        await webview.postMessage({ type: 'image', id: message.id, version: document.version, src: ref, display: webview.asWebviewUri(vscode.Uri.file(path.resolve(path.dirname(document.uri.fsPath), ref))).toString() });
      }
    };
    subscriptions.push(webview.onDidReceiveMessage(message => {
      queue = queue.then(() => handle(message)).catch(async error => { await webview.postMessage({ type: 'error', id: message?.id, message: error instanceof Error ? error.message : '操作に失敗しました。' }); });
    }));
    panel.onDidDispose(() => { disposed = true; saveWaiters.forEach(resolve => resolve()); saveWaiters.clear(); subscriptions.forEach(s => s.dispose()); });
    const nonce = randomBytes(24).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'style.css'));
    webview.html = `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${css}"><title>ブログ記事をビジュアル編集</title></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}
