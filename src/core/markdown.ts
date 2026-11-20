import { defaultMarkdownParser, defaultMarkdownSerializer, schema as baseSchema, MarkdownParser, MarkdownSerializer } from 'prosemirror-markdown';
import { Schema, type Node as PMNode } from 'prosemirror-model';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkDirective from 'remark-directive';

export const schema = new Schema({
  nodes: baseSchema.spec.nodes.addBefore('hard_break', 'soft_break', {
    inline: true, group: 'inline', selectable: false,
    parseDOM: [{ tag: 'span[data-softbreak]' }],
    toDOM: () => ['span', { 'data-softbreak': 'true' }, '\n'],
    leafText: () => '\n',
  }),
  marks: baseSchema.spec.marks,
});
const tokenizer = defaultMarkdownParser.tokenizer;
const parser = new MarkdownParser(schema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  softbreak: { node: 'soft_break' },
  image: { node: 'image', getAttrs: token => ({
    src: token.attrGet('src'), title: token.attrGet('title') || null,
    alt: tokenizer.renderer.renderInlineAsText(token.children ?? [], tokenizer.options, {}),
  }) },
});
const serializer = new MarkdownSerializer({ ...defaultMarkdownSerializer.nodes,
  soft_break: state => state.write('\n'),
}, defaultMarkdownSerializer.marks);
const syntax = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkDirective);
const unsupported: Record<string, string> = {
  table: 'テーブル', html: 'HTML / JSX', math: '数式', inlineMath: 'インライン数式',
  containerDirective: 'ディレクティブ', leafDirective: 'ディレクティブ', textDirective: 'ディレクティブ',
  delete: '取り消し線', footnoteDefinition: '脚注', footnoteReference: '脚注',
};
export function safetyReason(markdown: string): string | undefined {
  const tree = syntax.parse(markdown);
  let reason: string | undefined;
  function visit(node: any) {
    if (unsupported[node.type]) reason ??= `${unsupported[node.type]}は安全にビジュアル編集できません。ソースで編集してください。`;
    if (node.type === 'listItem' && node.checked != null) reason ??= 'タスクリストは未対応です。ソースで編集してください。';
    // Code nodes are opaque: apparent HTML, math and directives inside them are never inspected.
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  if (reason) return reason;
  try {
    const parsed = parseMarkdown(markdown);
    const output = serializeMarkdown(parsed);
    // The editor schema must preserve all parsed structure, including code and image references.
    if (!parsed.eq(parseMarkdown(output))) return 'Markdownの構造を安全に保持できません。ソースで編集してください。';
    // CommonMark HTML output detects text silently lost by a schema parser (e.g. image alt markup).
    const tokenizer = defaultMarkdownParser.tokenizer;
    if (tokenizer.render(markdown) !== tokenizer.render(output)) {
      // Formatting-only whitespace and list tightness differences are acceptable.
      const normalize = (s: string) => s.replace(/\n(?=<\/?(?:ul|ol|li|blockquote|p|h[1-6]|pre|hr))/g, '').replace(/(<\/(?:ul|ol|li|blockquote|p|h[1-6]|pre)>|<hr[^>]*>)\n/g, '$1');
      if (normalize(tokenizer.render(markdown)) !== normalize(tokenizer.render(output))) return '往復変換で内容が変わる構文があります。ソースで編集してください。';
    }
  } catch { return 'Markdownを安全に変換できません。ソースで編集してください。'; }
  return undefined;
}
export function parseMarkdown(markdown: string): PMNode { return parser.parse(markdown); }
export function serializeMarkdown(doc: PMNode): string { return serializer.serialize(doc); }
