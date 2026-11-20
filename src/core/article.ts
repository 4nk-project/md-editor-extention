import { parseDocument, isMap, isScalar, isSeq } from 'yaml';
import { safetyReason } from './markdown';
export type FieldType = 'string' | 'multiline' | 'date' | 'stringArray' | 'boolean' | 'image';
export interface Field { key: string; label: string; type: FieldType }
export type FieldValue = string | string[] | boolean;
export interface FieldPatch { key: string; value?: FieldValue; remove?: boolean }
export const defaultFields: Field[] = [
  { key: 'title', label: 'タイトル', type: 'string' }, { key: 'description', label: '説明', type: 'multiline' },
  { key: 'pubDate', label: '公開日', type: 'date' }, { key: 'tags', label: 'タグ（1行に1件）', type: 'stringArray' },
  { key: 'heroImage', label: 'アイキャッチ画像', type: 'image' }, { key: 'draft', label: '下書き', type: 'boolean' },
];
export function validFields(value: unknown): value is Field[] {
  return Array.isArray(value) && value.length <= 100 && value.every(f => f && typeof f.key === 'string' && f.key.length > 0 && f.key.length < 200 && typeof f.label === 'string' && ['string','multiline','date','stringArray','boolean','image'].includes(f.type)) && new Set(value.map(f => f.key)).size === value.length;
}
export function splitArticle(text: string) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const start = bom.length;
  const opening = /^---[ \t]*\r?\n/.exec(text.slice(start));
  if (!opening) return { prefix: bom, yaml: null, body: text.slice(start), eol, bom, error: undefined as string | undefined };
  const restStart = start + opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(text.slice(restStart));
  if (!closing) return { prefix: text, yaml: null, body: '', eol, bom, error: 'frontmatterの終端がありません。ソースで修正してください。' };
  const end = restStart + closing.index + closing[0].length;
  return { prefix: text.slice(0, end), yaml: text.slice(restStart, restStart + closing.index), body: text.slice(end), eol, bom, error: undefined };
}
export function inspectArticle(text: string, fields: Field[]) {
  const parts = splitArticle(text);
  let error = parts.error;
  const yaml = parseDocument(parts.yaml ?? '', { keepSourceTokens: true });
  if (yaml.errors.length || yaml.warnings.length) error ??= 'YAMLが不正、または未対応のタグがあります。ソースで修正してください。';
  if (yaml.contents && !isMap(yaml.contents)) error ??= 'frontmatterはキーと値のマップである必要があります。';
  try { yaml.toJS({ maxAliasCount: 100 }); } catch { error ??= 'YAMLエイリアスを安全に読み込めません。'; }
  error ??= safetyReason(parts.body);
  const values: Record<string, { present: boolean; value?: FieldValue; error?: string }> = Object.create(null);
  for (const field of fields) {
    const present = isMap(yaml.contents) && yaml.has(field.key);
    const node = present ? yaml.get(field.key, true) : undefined;
    let value: unknown = undefined;
    if (isScalar(node)) value = node.value;
    else if (isSeq(node) && node.items.every(i => isScalar(i) && typeof i.value === 'string')) value = node.items.map(i => (i as any).value);
    const compatible = !present || (field.type === 'boolean' ? typeof value === 'boolean' : field.type === 'stringArray' ? Array.isArray(value) : typeof value === 'string');
    values[field.key] = { present, value: compatible ? value as FieldValue : undefined, error: compatible ? undefined : '既存の値の型がフォーム設定と異なります。ソースで編集してください。' };
  }
  return { ...parts, error, values, yamlDocument: yaml };
}
export function validPatch(patch: unknown, fields: Field[]): patch is FieldPatch {
  if (!patch || typeof patch !== 'object') return false;
  const p = patch as FieldPatch;
  const f = fields.find(f => f.key === p.key);
  if (!f) return false;
  if (p.remove === true) return p.value === undefined;
  const v = p.value;
  return f.type === 'boolean' ? typeof v === 'boolean' : f.type === 'stringArray' ? Array.isArray(v) && v.length <= 10000 && v.every(s => typeof s === 'string' && s.length <= 100000) : typeof v === 'string' && v.length <= 100000;
}
export function updateArticle(text: string, fields: Field[], body: string | undefined, patches: FieldPatch[]): string {
  const article = inspectArticle(text, fields);
  if (article.error) throw new Error(article.error);
  if (patches.some(p => !validPatch(p, fields))) throw new Error('記事情報の入力形式が不正です。');
  let prefix = article.prefix;
  if (patches.length) {
    const doc = article.yamlDocument;
    for (const patch of patches) {
      if (article.values[patch.key]?.error) throw new Error('既存の値の型を変更できません。');
      if (patch.remove) doc.delete(patch.key);
      else doc.set(patch.key, patch.value);
    }
    const content = doc.toString({ lineWidth: 0 }).replace(/\r?\n/g, article.eol);
    prefix = article.bom + '---' + article.eol + content + '---' + article.eol;
  }
  let nextBody = article.body;
  if (body !== undefined) {
    const reason = safetyReason(body);
    if (reason) throw new Error(reason);
    nextBody = body.replace(/\r?\n/g, article.eol);
    if (/\r?\n$/.test(article.body) && !nextBody.endsWith(article.eol)) nextBody += article.eol;
    if (!/\r?\n$/.test(article.body)) nextBody = nextBody.replace(/(?:\r?\n)+$/, '');
  }
  if (body !== undefined && nextBody && article.yaml !== null && !prefix.endsWith('\n')) prefix += article.eol;
  return prefix + nextBody;
}
export function minimalChange(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length, nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  return { start, end, text: after.slice(start, nextEnd) };
}
