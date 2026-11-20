import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { copyImage, imageExtension, inside } from '../src/core/images';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=','base64');
test('画像を一意な名前でコピーし元データを保持',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'astro-images-'));
 try {await mkdir(path.join(root,'posts'));const article=path.join(root,'posts','test.md');
 const one=await copyImage(root,article,'assets/{name}',png),two=await copyImage(root,article,'assets/{name}',png);
 assert.notEqual(one,two);assert.match(one,/^\.\/assets\/test\/.+\.png$/);assert.deepEqual(await readFile(path.resolve(path.dirname(article),one)),png);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('ワークスペース脱出・symlink脱出を拒否して外部にディレクトリを作らない',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'astro-root-')),outside=await mkdtemp(path.join(os.tmpdir(),'astro-out-'));
 try {await symlink(outside,path.join(root,'link'));
 await assert.rejects(copyImage(root,path.join(root,'a.md'),'../escape',png));
 await assert.rejects(copyImage(root,path.join(root,'a.md'),'link/new',png));
 assert.deepEqual(await readdir(outside),[]);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('画像形式とパス境界を検証',()=>{assert.equal(imageExtension(png),'.png');assert.equal(imageExtension(Buffer.from('<svg/>')),undefined);assert.equal(inside('/workspace','/workspace-other/a'),false);});
