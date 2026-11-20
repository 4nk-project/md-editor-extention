import { runTests } from '@vscode/test-electron';
import { chromium } from 'playwright';
import { mkdir, rm, copyFile, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const project=process.cwd(),root=path.join(project,'.test-workspace');
const installed=process.argv.includes('--installed');
const installedExtensions=process.env.ASTRO_TEST_EXTENSIONS_DIR || path.join(project,'.test-install','extensions');
const manifest=JSON.parse(await readFile(path.join(project,'package.json'),'utf8'));
const extensionId=manifest.publisher+'.'+manifest.name;
let extensionPath=project;
if(installed){ extensionPath=path.join(project,'.test-install','harness');await mkdir(extensionPath,{recursive:true});await writeFile(path.join(extensionPath,'package.json'),JSON.stringify({name:'astro-test-harness',publisher:'local-test',version:'0.0.1',engines:{vscode:'^1.96.0'},main:'./index.cjs',activationEvents:[]}));await writeFile(path.join(extensionPath,'index.cjs'),'exports.activate = () => {};'); }
await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});await mkdir('artifacts',{recursive:true});
await mkdir(path.join(root,'profile','User'),{recursive:true});await writeFile(path.join(root,'profile','User','settings.json'),JSON.stringify({'files.simpleDialog.enable':true,'workbench.startupEditor':'none','chat.disableAIFeatures':true}));
await copyFile('fixtures/sample.md',path.join(root,'article.md'));await copyFile('fixtures/sample.png',path.join(root,'sample.png'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const execution=runTests({vscodeExecutablePath:'/Applications/Visual Studio Code.app/Contents/MacOS/Code',extensionDevelopmentPath:extensionPath,extensionTestsPath:path.join(project,'scripts/vscode-tests.cjs'),extensionTestsEnv:{ASTRO_TEST_ROOT:root,ASTRO_TEST_EXTENSION_ID:extensionId},launchArgs:[root,'--user-data-dir='+path.join(root,'profile'),'--extensions-dir='+(installed?installedExtensions:path.join(root,'extensions')),'--disable-workspace-trust',...(installed?[]:['--disable-extensions']),'--disable-updates','--disable-telemetry','--disable-gpu','--remote-debugging-port=9337']});
let launchError; execution.catch(e=>{ launchError=e; });
let browser,commandId=0;
async function host(type,extra={}) {
 const id=++commandId;await writeFile(path.join(root,'command.json'),JSON.stringify({id,type,...extra}));
 for(let i=0;i<100;i++){await delay(100);try{const response=JSON.parse(await readFile(path.join(root,'response.json'),'utf8'));if(response.id===id){if(response.error)throw Error(response.error);return response.result;}}catch(e){if(e.message?.startsWith('Error:'))throw e;}}
 throw Error('Host command timeout '+type);
}
const checks=[];
try {
 for(let i=0;i<100;i++){if(launchError)throw launchError;try{browser=await chromium.connectOverCDP('http://127.0.0.1:9337');break;}catch{await delay(500);}}
 if(!browser)throw Error('VS Code CDP unavailable');
 let frame,page;
 for(let i=0;i<100;i++) {
  for(const context of browser.contexts())for(const p of context.pages())for(const f of p.frames())if(await f.locator('#toolbar').count().catch(()=>0)){frame=f;page=p;}
  if(frame && await frame.locator('.ProseMirror').count())break;
  await delay(300);
 }
 if(!frame) throw Error('Webview not found');
 await frame.locator('.ProseMirror h1').waitFor();
 
 const ready=JSON.parse(await readFile(path.join(root,'ready.json'),'utf8'));if(installed)assert.ok(ready.extensionPath.startsWith(installedExtensions));
 const initial=await host('snapshot');assert.equal(initial.dirty,false);checks.push('未編集時の無変更');
 assert.equal(await frame.locator('.article-image img').first().evaluate(img=>img.complete&&img.naturalWidth>0),true);checks.push('正式なWebview URIによるローカル画像表示');
 await page.screenshot({path:'artifacts/editor-dark.png'});
 const editor=frame.locator('.ProseMirror');await editor.locator('p').last().click();await editor.press('Meta+ArrowDown');await editor.press('End');await editor.press('Enter');await editor.pressSequentially('日本語の編集テスト');
 await delay(1800);

 let changed=await host('snapshot');assert.match(changed.text,/日本語の編集テスト/);assert.ok(changed.dirty);checks.push('日本語本文入力・TextDocumentへの反映');
 assert.equal(initial.text.split('---')[1],changed.text.split('---')[1]);checks.push('本文編集でfrontmatter完全保持');
 // Actual Chromium IME composition events: no conversion or host updates before commit.
 await editor.locator('p').last().click();await editor.press('Meta+ArrowDown');
 const cdp=await browser.contexts()[0].newCDPSession(page);
 await cdp.send('Input.imeSetComposition',{text:'にほんご',selectionStart:4,selectionEnd:4});await delay(500);
 let composingDoc=await host('snapshot');assert.doesNotMatch(composingDoc.text,/にほんご/);
 await cdp.send('Input.insertText',{text:'日本語変換確定'});await delay(800);
 changed=await host('snapshot');assert.match(changed.text,/日本語変換確定/);assert.equal(changed.text.split('日本語変換確定').length-1,1);assert.doesNotMatch(changed.text,/にほんご/);checks.push('Chromium IME変換中の同期抑止・確定後の日本語保持');
 await editor.press('ControlOrMeta+s');await delay(600);assert.equal((await host('snapshot')).dirty,false);checks.push('Webviewの通常保存');
 await editor.pressSequentially('保存メニューの直前入力');await host('save');
 await delay(400);assert.equal((await host('snapshot')).dirty,false);assert.match(await readFile(path.join(root,'article.md'),'utf8'),/保存メニューの直前入力/);checks.push('保存イベントで未送信入力を確定');
 const saved=await host('snapshot');
 await editor.pressSequentially('Undo対象');await delay(650);await editor.press('ControlOrMeta+z');await delay(600);assert.doesNotMatch((await host('snapshot')).text,/Undo対象/);
 await editor.press('ControlOrMeta+Shift+z');await delay(600);assert.match((await host('snapshot')).text,/Undo対象/);checks.push('VS CodeのUndo・Redo');
 const title=frame.locator('#field-title');await title.fill('編集後タイトル');await delay(650);assert.match((await host('snapshot')).text,/編集後タイトル/);checks.push('記事情報編集と未知YAML保持');
 await host('replace',{text:saved.text.replace('書くことに、集中する。','ソースからの変更。')});await frame.locator('.ProseMirror h1').filter({hasText:'ソースからの変更。'}).waitFor();checks.push('ソース変更をWebviewへ反映');
 // Drop a real File through the webview's DOM drop path.
 await editor.locator('p').last().click();await editor.press('Meta+ArrowDown');
 const image=await readFile('fixtures/sample.png');
 await editor.evaluate((el,base64)=>{const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'drop.png',{type:'image/png'}));el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:150,clientY:250}));},image.toString('base64'));
 await frame.locator('#input-dialog[open]').waitFor();await frame.locator('input[name=alt]').fill('ドロップ画像');await frame.locator('#dialog-submit').click();await delay(700);assert.match((await host('snapshot')).text,/!\[ドロップ画像\]\(\.\/assets\/article\/.+\.png\)/);checks.push('画像Fileのドロップ・コピー・代替テキストと相対参照');
 await frame.locator('[data-action=image]').click();
 const picker=page.locator('.quick-input-widget input').first();await picker.waitFor({state:'visible'});await picker.fill(path.join(root,'sample.png'));await picker.press('Enter');
 await frame.locator('#input-dialog[open]').waitFor();await frame.locator('input[name=alt]').fill('選択した画像');await frame.locator('#dialog-submit').click();await delay(800);assert.match((await host('snapshot')).text,/選択した画像/);checks.push('VS Codeファイル選択ダイアログからの画像コピー');
 await browser.contexts()[0].route('https://example.com/astro-test.png',route=>route.fulfill({status:200,contentType:'image/png',body:image}));
 await frame.locator('[data-action=imageUrl]').click();await frame.locator('input[name=src]').fill('https://example.com/astro-test.png');await frame.locator('input[name=alt]').fill('HTTPS画像');await frame.locator('#dialog-submit').click();await delay(800);
 assert.equal(await frame.locator('img[alt="HTTPS画像"]').evaluate(img=>img.complete&&img.naturalWidth>0),true);assert.match((await host('snapshot')).text,/https:\/\/example.com\/astro-test.png/);checks.push('HTTPS画像URLの表示と元参照文字列の保存（通信はテスト内で応答）');
 await host('theme',{value:'Default Light Modern'});await delay(500);await frame.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'artifacts/editor-light.png'});checks.push('ライト・ダークテーマで描画');
 await editor.locator('p').last().click();await editor.press('Meta+ArrowDown');
 await cdp.send('Input.imeSetComposition',{text:'競合の入力',selectionStart:5,selectionEnd:5});
 const external='# 外部の変更を優先\n\n外部本文\n';await host('replace',{text:external});
 await cdp.send('Input.insertText',{text:'競合前の確定入力'});await delay(900);
 assert.equal((await host('snapshot')).text,external);assert.equal(await frame.locator('#recovery').isVisible(),true);assert.match(await frame.locator('#recovery textarea').inputValue(),/競合前の確定入力/);checks.push('IME変換中の外部更新を再同期し未送信入力を退避');
 await host('replace',{text:await readFile('fixtures/unsupported.md','utf8')});await frame.locator('#notice').filter({hasText:'テーブル'}).waitFor();assert.equal(await frame.locator('#field-title').isDisabled(),true);assert.equal(await frame.locator('#readonly-source').isVisible(),true);checks.push('未対応構文で本文・記事情報の編集を無効化');
 await host('replace',{text:await readFile('fixtures/invalid-yaml.md','utf8')});await frame.locator('#notice').filter({hasText:'YAML'}).waitFor();checks.push('不正YAMLで書き換え拒否');
 await host('finish');
 await writeFile('artifacts/ui-results.json',JSON.stringify({mode:installed?'installed-vsix':'development',passed:checks},null,2));console.log(JSON.stringify(checks,null,2));
 await browser.close();await execution;
}catch(e){console.error(e);if(browser){for(const p of browser.contexts()[0].pages())await p.screenshot({path:'artifacts/ui-failure.png'}).catch(()=>{});await host('finish').catch(()=>{});await browser.close().catch(()=>{});}process.exitCode=1;}
