const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async function () {
  const root=process.env.ASTRO_TEST_ROOT;
  const uri=vscode.Uri.file(path.join(root,'article.md'));
  await vscode.commands.executeCommand('vscode.openWith',uri,'astroMarkdown.visualEditor');
  const doc=await vscode.workspace.openTextDocument(uri);
  const extensionId=process.env.ASTRO_TEST_EXTENSION_ID;
  if(!extensionId) throw new Error('ASTRO_TEST_EXTENSION_ID is required');
  await fs.writeFile(path.join(root,'ready.json'),JSON.stringify({trusted:vscode.workspace.isTrusted,extensionPath:vscode.extensions.getExtension(extensionId)?.extensionPath}));
  let last=0;
  for(let i=0;i<6000;i++) {
    let request;
    try {request=JSON.parse(await fs.readFile(path.join(root,'command.json'),'utf8'));} catch {}
    if(request && request.id!==last) {
      last=request.id;
      try {
        let result;
        if(request.type==='snapshot') result={text:doc.getText(),dirty:doc.isDirty,version:doc.version};
        if(request.type==='replace') { const edit=new vscode.WorkspaceEdit();edit.replace(uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),request.text);result=await vscode.workspace.applyEdit(edit); }
        if(request.type==='save') result=await doc.save();
        if(request.type==='undo' || request.type==='redo') await vscode.commands.executeCommand(request.type);
        if(request.type==='theme') await vscode.workspace.getConfiguration('workbench').update('colorTheme',request.value,vscode.ConfigurationTarget.Global);
        if(request.type==='finish') { await fs.writeFile(path.join(root,'response.json'),JSON.stringify({id:last,result:true}));return; }
        await fs.writeFile(path.join(root,'response.json'),JSON.stringify({id:last,result}));
      }catch(e){await fs.writeFile(path.join(root,'response.json'),JSON.stringify({id:last,error:String(e)}));}
    }
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error('UI test timed out');
};
