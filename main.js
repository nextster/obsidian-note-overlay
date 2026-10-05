const { Plugin, Notice, FuzzySuggestModal, TFile, Scope, setIcon } = require('obsidian');
const http = require('node:http');
const path = require('node:path');

class NotePicker extends FuzzySuggestModal {
  constructor(plugin) { super(plugin.app); this.plugin=plugin; this.setPlaceholder('Найти заметку…'); }
  getItems() { return this.app.vault.getMarkdownFiles().sort((a,b)=>b.stat.mtime-a.stat.mtime); }
  getItemText(file) { return file.path; }
  onChooseItem(file) { void this.plugin.openNote(file).catch(e=>this.plugin.report(e)); }
}
module.exports = class PanelMicroDemo extends Plugin {
  async onload() {
    if(process.platform!=='darwin')throw new Error('Note Panel requires macOS');
    this.settings=await this.loadData() || {};
    const folder=path.join(this.app.vault.adapter.getBasePath(),this.manifest.dir);
    const remote=require('@electron/remote');
    this.mainWindow=remote.require(path.join(folder,'main-window.cjs'));
    this.mainWindowId=remote.getCurrentWindow().id;
    this.mainWindow.install(this.mainWindowId);
    const {withoutPanel}=require(path.join(folder,'session-layout.cjs'));
    const workspace=this.app.workspace;
    this.panelLeafIds=new Set(this.settings.panelLeafIds||[]);
    this.livePanelLeafIds=new Set();
    this.originalGetLayout=workspace.getLayout;
    this.filteredGetLayout=(...args)=>withoutPanel(this.originalGetLayout.apply(workspace,args),this.panelLeafIds);
    workspace.getLayout=this.filteredGetLayout;
    this.originalReadWorkspaceFile=workspace.readWorkspaceFile;
    this.filteredReadWorkspaceFile=async(...args)=>withoutPanel(await this.originalReadWorkspaceFile.apply(workspace,args),this.panelLeafIds);
    workspace.readWorkspaceFile=this.filteredReadWorkspaceFile;
    workspace.onLayoutReady(()=>{if(!this.unloading)void this.removeRestoredPanels().catch(e=>this.report(e));});
    this.addCommand({id:'toggle',name:'Toggle note panel',callback:()=>this.toggle().catch(e=>this.report(e))});
    this.addCommand({id:'choose-note',name:'Choose note in panel',callback:()=>this.openPicker().catch(e=>this.report(e))});
    this.addCommand({id:'new-tab',name:'New tab in note panel',callback:()=>this.newTab(true).catch(e=>this.report(e))});
    this.registerEvent(workspace.on('file-open',()=>this.queueSessionSave()));
    this.registerEvent(workspace.on('active-leaf-change',leaf=>{
      if(this.getPanelLeaves().includes(leaf)) {
        this.leaf=leaf;
        // Also cover switches made by Obsidian commands or its tab-group menu.
        void this.saveEditor().catch(e=>this.report(e));
      }
      this.queueSessionSave();
    }));
    this.registerEvent(workspace.on('layout-change',()=>this.queueSessionSave()));
    this.server=http.createServer((req,res)=>this.handleRequest(req,res));
    this.server.on('error',error=>this.report(error));
    this.server.listen(51235,'127.0.0.1');
  }
  report(error){this.lastError=error?.message||String(error);console.error(error);new Notice('Note panel: '+this.lastError);}
  status(){const w=this.panel;return {ok:true,version:this.manifest.version,exists:!!w&&!w.isDestroyed(),
    tabs:this.getPanelLeaves().length,activeTab:this.getPanelLeaves().indexOf(this.activePanelLeaf()),
    main:this.mainWindow?.status(this.mainWindowId)||null,
    native:w&&!w.isDestroyed()?JSON.parse(this.native.inspect(w.getNativeWindowHandle(),false)):null,error:this.lastError||null};}
  async handleRequest(req,res){
    const host=req.headers.host;
    const site=req.headers['sec-fetch-site'];
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||
      !['127.0.0.1:51235','localhost:51235','[::1]:51235'].includes(host)||req.headers.origin||
      (site&&site!=='none')){res.writeHead(403);res.end();return;}
    try{
      if(req.url==='/reload'&&req.method==='POST'){
        await this.saveEditor();await this.persistSession();res.end('reloading');
        setTimeout(async()=>{const p=this.app.plugins;try{await p.disablePlugin(this.manifest.id);await this.cleanupPromise;}finally{await p.enablePlugin(this.manifest.id);}},100);return;
      }
      if(req.url==='/toggle'&&req.method==='GET')await this.toggle();
      else if(req.url==='/hide'&&req.method==='GET')await this.hidePanel();
      else if(req.url==='/open'&&req.method==='POST'){
        let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw new Error('Request too large');}
        const file=this.app.vault.getAbstractFileByPath(JSON.parse(body).path);
        if(!(file instanceof TFile)||file.extension!=='md')throw new Error('Markdown note not found');
        await this.openNote(file);
      }else if(req.url!=='/status'||req.method!=='GET'){res.writeHead(404);res.end();return;}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(this.status()));
    }catch(error){this.lastError=error?.message||'Panel request failed';res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Panel request failed'}));}
  }
  getPanelLeaves(){
    const leaves=[];
    const walk=node=>{if(!node)return;if(node.type==='leaf')leaves.push(node);else node.children?.forEach(walk);};
    walk(this.panelContainer);return leaves;
  }
  activePanelLeaf(){
    const leaves=this.getPanelLeaves();
    if(leaves.includes(this.app.workspace.activeLeaf))return this.app.workspace.activeLeaf;
    if(leaves.includes(this.leaf))return this.leaf;
    return leaves[0]||null;
  }
  syncPanelLeaves(){
    const leaves=this.getPanelLeaves();
    const ids=new Set(leaves.map(leaf=>leaf.id));
    for(const id of this.livePanelLeafIds)if(!ids.has(id))this.panelLeafIds.delete(id);
    for(const id of ids)this.panelLeafIds.add(id);
    this.livePanelLeafIds=ids;
    this.leaf=this.activePanelLeaf();
    return leaves;
  }
  queueSessionSave(){
    if(this.unloading||this.restoring||!this.panelContainer?.win||!this.getPanelLeaves().length)return;
    // Mark every native-created tab synchronously before Obsidian saves layout.
    this.syncPanelLeaves();
    clearTimeout(this.sessionTimer);
    this.sessionTimer=setTimeout(()=>void this.persistSession().catch(e=>this.report(e)),80);
  }
  async persistSession(){
    if(this.restoring||this.sessionReady===false||!this.panelContainer?.win)return;
    const leaves=this.syncPanelLeaves();
    if(!leaves.length)return;
    this.settings.tabs=leaves.map(leaf=>({file:leaf.view?.file?.path||null}));
    this.settings.activeTab=Math.max(0,leaves.indexOf(this.activePanelLeaf()));
    this.settings.panelLeafIds=Array.from(this.panelLeafIds);
    const file=this.activePanelLeaf()?.view?.file;
    if(file)this.settings.lastFile=file.path;
    await this.saveData(this.settings);
  }
  runAction(action){
    const result=(this.actionQueue||Promise.resolve()).then(()=>this.unloading?undefined:action());
    this.actionQueue=result.catch(()=>{});return result;
  }
  async ensurePanel(){
    if(this.unloading)throw new Error('Note Panel is unloading');
    if(this.panel&&!this.panel.isDestroyed())return;
    if(this.opening)return this.opening;
    this.opening=this.createPanel();try{await this.opening;}finally{this.opening=null;}
  }
  async createPanel(){
    if(!this.app.workspace.layoutReady)throw new Error('Obsidian is still loading');
    const remote=require('@electron/remote');
    const folder=path.join(this.app.vault.adapter.getBasePath(),this.manifest.dir);
    this.native=remote.require(path.join(folder,'panel_bridge.node'));
    this.popup=remote.require(path.join(folder,'popup-main.cjs'));
    this.openerId=remote.getCurrentWebContents().id;
    this.restoring=true;
    this.sessionReady=false;
    this.popup.arm(this.openerId);
    try{this.leaf=this.app.workspace.openPopoutLeaf({size:{width:700,height:560}});}
    finally{this.popup.disarm(this.openerId);}
    this.panelContainer=this.leaf.getContainer();
    this.panelWindow=this.panelContainer.win;
    this.syncPanelLeaves();
    const deadline=Date.now()+5000;
    while(!this.panelWindow.electronWindow&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
    this.panel=this.panelWindow.electronWindow ? remote.BrowserWindow.fromId(this.panelWindow.electronWindow.id) : null;
    if(!this.panel){this.leaf.detach();this.leaf=null;this.panelContainer=null;this.restoring=false;throw new Error('Popout window did not initialize');}
    if(this.unloading){this.restoring=false;throw new Error('Note Panel is unloading');}
    const w=this.panel;
    w.setAlwaysOnTop(true,'floating');
    w.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true,skipTransformProcessType:true});
    w.webContents.setBackgroundThrottling(false);
    const bounds=this.settings.bounds;
    if(bounds&&remote.screen.getAllDisplays().some(d=>bounds.x<d.bounds.x+d.bounds.width&&bounds.x+bounds.width>d.bounds.x&&bounds.y<d.bounds.y+d.bounds.height&&bounds.y+bounds.height>d.bounds.y))w.setBounds(bounds);
    this.boundsHandler=()=>{clearTimeout(this.boundsTimer);this.boundsTimer=setTimeout(()=>{
      if(!w.isDestroyed()){this.settings.bounds=w.getBounds();void this.saveData(this.settings);}
    },400);};
    w.on('resize',this.boundsHandler);w.on('moved',this.boundsHandler);
    try{
      const tabs=Array.isArray(this.settings.tabs)&&this.settings.tabs.length?this.settings.tabs:[{file:this.settings.lastFile||null}];
      const group=this.leaf.parent;
      const restored=[];
      for(const tab of tabs){
        const leaf=restored.length?this.app.workspace.createLeafInParent(group,group.children.length):this.leaf;
        this.panelLeafIds.add(leaf.id);
        const file=tab?.file?this.app.vault.getAbstractFileByPath(tab.file):null;
        if(file instanceof TFile&&file.extension==='md')await leaf.openFile(file,{state:{mode:'source',source:false}});
        if(this.unloading)throw new Error('Note Panel is unloading');
        restored.push(leaf);
      }
      this.leaf=restored[Math.min(Math.max(0,this.settings.activeTab||0),restored.length-1)];
      this.app.workspace.setActiveLeaf(this.leaf,{focus:false});
      this.installToolbar();
      this.installPanelKeys();
      const {installResize}=require(path.join(folder,'panel-resize.cjs'));
      this.resizeInteraction?.dispose();
      this.resizeInteraction=installResize(this.panelWindow,w,error=>this.report(error),{
        getCursor:()=>remote.screen.getCursorScreenPoint()
      });
    }finally{this.restoring=false;}
    this.sessionReady=true;
    await this.persistSession();
    this.app.workspace.requestSaveLayout();
  }
  installToolbar(){
    const doc=this.panelWindow.document;
    doc.body.classList.add('note-panel-window');
    this.style=doc.createElement('style');this.style.textContent=`
      .note-panel-window .workspace-tab-header-container{padding-right:30px}
      .note-panel-window .workspace-tab-header-tab-list{display:none}
      .note-panel-window .panel-note-picker{position:absolute;right:5px;top:7px;z-index:10;width:22px;height:22px;padding:3px;border:0;border-radius:4px;background:transparent;box-shadow:none;color:var(--text-muted);-webkit-app-region:no-drag}
      .note-panel-window .panel-note-picker:hover{background:var(--background-modifier-hover);color:var(--text-normal)}
      .note-panel-window .panel-note-picker svg{width:14px;height:14px}
    `;doc.head.append(this.style);
    this.toolbar=doc.createElement('button');this.toolbar.className='panel-note-picker clickable-icon';
    this.toolbar.setAttribute('aria-label','Открыть заметку');this.toolbar.title='Открыть заметку';
    setIcon(this.toolbar,'file-search');
    this.toolbar.onclick=()=>void this.openPicker().catch(e=>this.report(e));
    const workspace=doc.querySelector('.workspace');
    this.layout=workspace.parentElement;
    this.layout.append(this.toolbar);
    const onTabClick=event=>{
      const target=event.target?.closest?.('.workspace-tab-header,.workspace-tab-header-new-tab');
      if(!target||event.button>1)return;
      const leaves=this.getPanelLeaves();
      const leaf=leaves.find(leaf=>leaf.tabHeaderEl===target);
      const newTab=target.matches('.workspace-tab-header-new-tab');
      if(!leaf&&!newTab)return;
      event.preventDefault();event.stopImmediatePropagation();
      const close=event.button===1||event.target.closest('.workspace-tab-header-inner-close-button');
      void (newTab?this.newTab(true):close?this.closeTab(leaf):this.selectTab(leaf)).catch(e=>this.report(e));
    };
    this.registerDomEvent(doc,'click',onTabClick,true);
    this.registerDomEvent(doc,'auxclick',onTabClick,true);
  }
  installPanelKeys(){
    // A per-window scope catches keys before Obsidian's forwarded popout events.
    // getLeaf(true) would otherwise create a tab in the main window.
    const keymap=this.app.keymap;
    this.previousPanelScope=keymap.getWindowStack(this.panelWindow).scope;
    this.panelScope=new Scope(this.previousPanelScope);
    this.panelScope.register(['Mod'],'t',()=>{void this.newTab(true).catch(e=>this.report(e));return false;});
    this.panelScope.register(['Mod'],'w',()=>{void this.closeTab(this.activePanelLeaf()).catch(e=>this.report(e));return false;});
    keymap.setWindowBaseScope(this.panelWindow,this.panelScope);
  }
  selectTab(leaf){return this.runAction(async()=>{
    if(!this.getPanelLeaves().includes(leaf))return;
    await this.saveEditor();this.leaf=leaf;this.app.workspace.setActiveLeaf(leaf,{focus:true});
    await this.persistSession();
  });}
  newTab(pick=false){return this.runAction(async()=>{
    await this.ensurePanel();await this.saveEditor();
    const group=this.activePanelLeaf().parent;
    this.leaf=this.app.workspace.createLeafInParent(group,group.children.length);
    this.syncPanelLeaves();this.app.workspace.setActiveLeaf(this.leaf,{focus:true});
    await this.persistSession();this.showPanel();
    if(pick)await this.showPicker();
  });}
  closeTab(leaf){return this.runAction(async()=>{
    const leaves=this.getPanelLeaves();if(!leaves.includes(leaf))return;
    const selected=this.activePanelLeaf();
    await this.saveEditor();
    if(leaves.length===1){await leaf.setViewState({type:'empty',state:{}});await this.persistSession();await this._hidePanel();return;}
    const index=leaves.indexOf(leaf);leaf.detach();
    this.leaf=selected!==leaf?selected:(leaves[index+1]||leaves[index-1]);
    this.app.workspace.setActiveLeaf(this.leaf,{focus:true});
    await this.persistSession();
  });}
  openPicker(){return this.runAction(async()=>{await this.ensurePanel();this.showPanel();await this.showPicker();});}
  async showPicker(){
    this.picker?.close();
    this.panel.focus();this.panelWindow.focus();
    const deadline=Date.now()+1000;
    while(this.app.workspace.getFocusedContainer()?.win!==this.panelWindow&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    if(this.app.workspace.getFocusedContainer()?.win!==this.panelWindow)throw new Error('Could not focus the note panel');
    this.app.workspace.setActiveLeaf(this.activePanelLeaf(),{focus:false});
    this.picker=new NotePicker(this);this.picker.open();
  }
  openNote(file){return this.runAction(()=>this._openNote(file));}
  async _openNote(file){
    await this.ensurePanel();await this.saveEditor();
    this.leaf=this.activePanelLeaf();
    await this.leaf.openFile(file,{state:{mode:'source',source:false}});
    this.app.workspace.setActiveLeaf(this.leaf,{focus:false});
    await this.persistSession();this.showPanel();this.leaf.view.editor?.focus();
  }
  toggle(){return this.runAction(()=>this._toggle());}
  async _toggle(){
    if(this.panel&&!this.panel.isDestroyed()){
      const state=JSON.parse(this.native.inspect(this.panel.getNativeWindowHandle(),false));
      if(state.visible&&state.onActiveSpace){await this._hidePanel();return;}
      this.showPanel();this.activePanelLeaf()?.view.editor?.focus();return;
    }
    const active=this.app.workspace.getActiveFile();
    const hasSession=Array.isArray(this.settings.tabs)&&this.settings.tabs.length;
    const saved=this.app.vault.getAbstractFileByPath(this.settings.lastFile||'');
    const file=saved instanceof TFile&&saved.extension==='md'?saved:active;
    await this.ensurePanel();
    if(!hasSession&&file instanceof TFile&&file.extension==='md'&&!this.activePanelLeaf()?.view.file)await this._openNote(file);
    else{this.showPanel();this.activePanelLeaf()?.view.editor?.focus();if(!hasSession&&!file)await this.showPicker();}
  }
  async removeRestoredPanels(){
    const leaves=[];
    const walk=node=>{if(!node)return;if(node.type==='leaf'&&this.panelLeafIds.has(node.id)&&!this.getPanelLeaves().includes(node))leaves.push(node);else node.children?.forEach(walk);};
    walk(this.app.workspace.floatingSplit);
    for(const leaf of leaves){if(leaf.view?.save)await leaf.view.save();leaf.detach();}
    await this.app.workspace.saveLayout();
  }
  showPanel(){if(this.unloading)return;this.panel.showInactive();this.native.inspect(this.panel.getNativeWindowHandle(),true);}
  async saveEditor(){for(const leaf of this.getPanelLeaves())if(leaf.view?.save)await leaf.view.save();}
  hidePanel(){return this.runAction(()=>this._hidePanel());}
  async _hidePanel(){this.resizeInteraction?.cancel();this.picker?.close();await this.saveEditor();await this.persistSession();if(this.panel&&!this.panel.isDestroyed())this.panel.hide();}
  onunload(){
    this.unloading=true;clearTimeout(this.boundsTimer);clearTimeout(this.sessionTimer);this.server?.close();try{this.popup?.disarm(this.openerId);}catch(_){}
    this.resizeInteraction?.dispose();
    try{this.mainWindow?.release(this.mainWindowId);}catch(error){console.warn('Main window cleanup:',error);}
    // Restore shared methods synchronously: Obsidian does not await Component.onunload.
    const workspace=this.app.workspace;
    if(workspace.getLayout===this.filteredGetLayout)workspace.getLayout=this.originalGetLayout;
    if(workspace.readWorkspaceFile===this.filteredReadWorkspaceFile)workspace.readWorkspaceFile=this.originalReadWorkspaceFile;
    this.picker?.close();
    const panel=this.panel;
    if(panel&&!panel.isDestroyed()){
      panel.removeListener('resize',this.boundsHandler);panel.removeListener('moved',this.boundsHandler);
      if(this.app.keymap.getWindowStack(this.panelWindow).scope===this.panelScope)this.app.keymap.setWindowBaseScope(this.panelWindow,this.previousPanelScope);
    }
    try{this.toolbar?.remove();this.style?.remove();this.panelWindow?.document.body.classList.remove('note-panel-window');}catch(_){}
    // Drain an already-running action before the final save and snapshot.
    // Newly queued actions see unloading and cannot create another popout.
    const pending=[this.actionQueue,this.opening].filter(Boolean);
    this.cleanupPromise=Promise.allSettled(pending).then(async()=>{
      await this.saveEditor();await this.persistSession();
      if(this.panel&&!this.panel.isDestroyed())this.panelContainer?.detach();
      workspace.requestSaveLayout();
    }).catch(error=>console.warn('Panel cleanup:',error));
    return this.cleanupPromise;
  }
};
