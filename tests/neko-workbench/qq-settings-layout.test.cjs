'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const installer=require('../../apps/neko-workbench/vendor/dsh-qqbot-workbench/install.cjs');

function nodes(node,visible=false){
  if(!node||typeof node!=='object')return [];
  const children=visible&&node.type==='details'&&!node.props.open?node.children.filter(child=>child?.type==='summary'):node.children;
  return [node,...children.flatMap(child=>nodes(child,visible))];
}
function text(node){return typeof node==='string'?node:(node?.children||[]).map(text).join('');}

test('adapted official QQ UI keeps QR visible and folds configuration, identifiers and manual credentials',t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'neko-qq-layout-'));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  fs.copyFileSync(installer.ARCHIVE,path.join(tmp,'qqbot.tgz'));
  execFileSync('tar',['-xzf','qqbot.tgz'],{cwd:tmp});
  const pkg=path.join(tmp,'package');installer.adaptPlugin(tmp,pkg);
  const source=fs.readFileSync(path.join(pkg,'lib/client.js'),'utf8')
    .replace('exports.apply = apply;','exports.BoundView = BoundView; exports.UnboundView = UnboundView; exports.apply = apply;');
  const entries={};
  const React={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),
    useState:value=>[value,()=>{}],useCallback:fn=>fn,useEffect:()=>{}};
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:value=>{entries[value.id]=value;}}}});
  const native=entries['@tencent-connect/dsh-qqbot'].factory();
  assert.equal(typeof native.apply,'function','native boot ID remains registered after reload');
  assert.equal(native.apply(),undefined,'native registration does not duplicate workbench menus');
  const ui=entries['@bigfish/qqbot-settings'].factory(name=>{assert.equal(name,'react');return React;});
  const section=ui.QQBotSettingsSection();
  const settings=nodes(section).find(node=>node.props['data-settings']==='qq');
  assert.ok(settings&&!settings.props.open);
  assert.ok(nodes(settings).some(node=>node.type?.name==='ConfigPanel'));
  assert.equal(nodes(section,true).some(node=>node.type?.name==='ConfigPanel'),false);
  assert.ok(nodes(section,true).some(node=>node.type?.name==='BindPanelBody'));

  const unbound=ui.UnboundView({state:{qrSvg:'data:image/test',url:'https://example.test'}});
  assert.ok(nodes(unbound,true).some(node=>node.type==='img'&&node.props.alt==='QQ 扫码二维码'));
  assert.ok(nodes(unbound,true).some(node=>node.type==='button'&&text(node)==='刷新二维码'));
  assert.equal(nodes(unbound,true).some(node=>node.type==='button'&&text(node)==='手动填写'),false);
  assert.ok(nodes(unbound).some(node=>node.type==='button'&&text(node)==='手动填写'));

  const bound=ui.BoundView({appId:'test-identifier',recheck(){}});
  assert.equal(nodes(bound,true).some(node=>node.type==='button'),false);
  assert.equal(nodes(bound,true).some(node=>node.children.includes('AppID test-identifier')),false);
  for(const label of ['更换凭据','解绑'])assert.ok(nodes(bound).some(node=>node.type==='button'&&text(node)===label));
});
