import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectArticle, updateArticle, defaultFields, splitArticle, minimalChange, validFields, validPatch } from '../src/core/article';
import { parseMarkdown, serializeMarkdown, safetyReason } from '../src/core/markdown';
const elements = `# 日本語の記事

## 見出し2

### 見出し3

#### 見出し4

##### 見出し5

###### 見出し6

本文、**太字**、*斜体*、\`inline\`、[リンク](https://example.com/path?q=1 "題名")。

- 一つ目
- 二つ目
  - 入れ子

3. 番号3
4. 番号4

> 引用\n>\n> 段落

\`\`\`typescript
const 日本語 = '<table> $x$ :::note';
\`\`\`

---

![画像の説明](./assets/日本語.png "画像タイトル")

末尾。  
改行。
`;
test('公式Markdown parser: 日本語・全対応要素の編集→保存→再読込', () => {
  assert.equal(safetyReason(elements), undefined);
  const parsed = parseMarkdown(elements);
  const edited = parsed.type.create(parsed.attrs, parsed.content.append(schemaParagraph('日本語を追記')));
  const output = serializeMarkdown(edited);
  assert.ok(edited.eq(parseMarkdown(output)));
  assert.match(output, /日本語を追記/);
});
function schemaParagraph(text: string) { const doc = parseMarkdown(text); return doc.content; }
for (const [name, source] of Object.entries({table:'| A | B |\n| - | - |\n| 1 | 2 |',html:'<div>本文</div>',math:'$$\nx^2\n$$',inlineMath:'数式 $x+y$ です',directive:':::note\n内容\n:::',task:'- [x] task',strike:'~~text~~',footnote:'text[^1]\n\n[^1]: note',jsx:'<Component />'})) {
  test(`未対応の${name}をASTで検出して書き換え拒否`,()=>{ assert.ok(safetyReason(source)); assert.throws(()=>updateArticle(source,defaultFields,'上書き',[])); });
}
test('コードのHTML・数式・directive・表を誤検出しない',()=>{
  assert.equal(safetyReason('```md\n<div>\n$x$\n:::note\n| A |\n| - |\n```'),undefined);
  assert.equal(safetyReason('`<script>$x$</script>`'),undefined);
  assert.equal(safetyReason('価格は100ドルです。\\$x\\$ と記載。'),undefined);
});
test('読み込みは何も追加せず元文字列を維持',()=>{
  for(const text of ['', '# 見出し', '---\ntitle: 記事 # コメント\n---\n\n本文\n', '\uFEFF本文\r\n']) {
    inspectArticle(text,defaultFields); assert.equal(updateArticle(text,defaultFields,undefined,[]),text);
  }
});
test('本文のみ変更はfrontmatterをバイト単位で保持',()=>{
  const original='\uFEFF---\r\n# コメント\r\ntitle: "記事"\r\nunknown: { a: 1, b: [true, null] }\r\n---\r\n旧本文\r\n';
  const next=updateArticle(original,defaultFields,'新本文',[]);
  assert.equal(splitArticle(next).prefix,splitArticle(original).prefix);
  assert.ok(next.endsWith('新本文\r\n'));
});
test('YAML編集は未知のネスト・コメント・文字列日付・falseを保持',()=>{
  const original='---\n# メモ\ntitle: "旧記事" # タイトル\nunknown:\n  nested: [1, true, "2026-01-01"] # 内部\npubDate: 2026-11-20\ndraft: false\n---\n本文';
  const next=updateArticle(original,defaultFields,undefined,[{key:'title',value:'新記事'}]);
  const article=inspectArticle(next,defaultFields);
  assert.equal(article.error,undefined);
  assert.match(next,/# メモ/);assert.match(next,/# タイトル/);assert.match(next,/# 内部/);
  assert.deepEqual(article.yamlDocument.toJS().unknown,{nested:[1,true,'2026-01-01']});
  assert.equal(article.values.draft.value,false);assert.equal(article.values.pubDate.value,'2026-11-20');
  assert.equal(article.body,'本文');
});
test('frontmatter無し・未設定・空文字・false・削除を区別',()=>{
  assert.equal(updateArticle('本文',defaultFields,'追記',[]),'追記');
  let next=updateArticle('本文',defaultFields,undefined,[{key:'title',value:''},{key:'draft',value:false}]);
  let article=inspectArticle(next,defaultFields);
  assert.deepEqual(article.values.title,{present:true,value:'',error:undefined});
  assert.equal(article.values.draft.value,false);assert.equal(article.values.tags.present,false);
  next=updateArticle(next,defaultFields,undefined,[{key:'title',remove:true}]);
  assert.equal(inspectArticle(next,defaultFields).values.title.present,false);
});
test('不正YAML・不正型・重複キー・未閉鎖frontmatterは保持して拒否',()=>{
  for(const text of ['---\ntitle: [\n---\n本文','---\ntitle: a\ntitle: b\n---\n本文','---\n- list\n---\n本文','---\ntitle: a\n本文']) {assert.ok(inspectArticle(text,defaultFields).error);assert.throws(()=>updateArticle(text,defaultFields,'new',[]));}
  const text='---\ntitle: 123\n---\n本文';
  assert.ok(inspectArticle(text,defaultFields).values.title.error);
  assert.throws(()=>updateArticle(text,defaultFields,undefined,[{key:'title',value:'abc'}]));
  assert.ok(updateArticle(text,defaultFields,'新本文',[]).includes('title: 123'));
});
test('CRLF・末尾改行無し・コード末尾空白・画像参照を保持',()=>{
  for(const ending of ['','\n','\r\n']) {
    const before='旧本文'+ending; const next=updateArticle(before,defaultFields,'新本文',[]);
    assert.equal(next,'新本文'+ending);
  }
  const code='```js\nlet a = " ";  \n\n```\n\n![説明](./assets/test.webp)';
  const out=serializeMarkdown(parseMarkdown(code));assert.ok(parseMarkdown(code).eq(parseMarkdown(out)));
  assert.match(out,/\.\/assets\/test.webp/);assert.doesNotMatch(out,/vscode-webview/);
});
test('差分編集は先頭・末尾の未変更部分を範囲外にする',()=>{assert.deepEqual(minimalChange('abc旧文xyz','abc新文xyz'),{start:3,end:4,text:'新'});});
test('設定・メッセージの値を検証',()=>{
  assert.ok(validFields(defaultFields));assert.equal(validFields([{key:'title',label:'a',type:'bad'}]),false);
  assert.equal(validFields([defaultFields[0],defaultFields[0]]),false);
  assert.equal(validPatch({key:'draft',value:'false'},defaultFields),false);
  assert.equal(validPatch({key:'missing',value:'x'},defaultFields),false);
  assert.ok(validPatch({key:'tags',value:['日本語']},defaultFields));
});
test('終端に改行がないfrontmatterにも本文を安全に追記',()=>{
 const text='---\ntitle: 記事\n---';const next=updateArticle(text,defaultFields,'本文',[]);
 assert.equal(next,'---\ntitle: 記事\n---\n本文');assert.equal(inspectArticle(next,defaultFields).error,undefined);
});
test('アンカー・エイリアス・引用した日付の意味を保持',()=>{
 const text='---\ntitle: &name "旧記事"\nreference: *name\npubDate: "2026-11-20T10:00:00+09:00"\n---\n本文';
 const next=updateArticle(text,defaultFields,undefined,[{key:'description',value:'説明'}]);
 assert.equal(inspectArticle(next,defaultFields).yamlDocument.toJS().reference,'旧記事');
 assert.equal(inspectArticle(next,defaultFields).values.pubDate.value,'2026-11-20T10:00:00+09:00');
});
test('段落内のソフト改行と装飾された画像altの意味を保持',()=>{
 for(const source of ['日本語の\n段落です。','**太字の\n途中です**','- リストの\n  続きです','![a **bold** and `code`](./image.png)']) {
  assert.equal(safetyReason(source),undefined);const doc=parseMarkdown(source);assert.ok(doc.eq(parseMarkdown(serializeMarkdown(doc))));
 }
 assert.match(serializeMarkdown(parseMarkdown('日本語の\n段落です。')),/日本語の\n段落です。/);
 assert.match(serializeMarkdown(parseMarkdown('![a **bold**](x.png)')),/a bold/);
});
