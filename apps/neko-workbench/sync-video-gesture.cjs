'use strict';
const fs=require('node:fs'),path=require('node:path');
const core=fs.readFileSync(path.join(__dirname,'hold-drag.js'),'utf8');
// Sandboxed preloads cannot require local modules. Bundle the small shared
// gesture function; expose no Electron API to remote site code.
fs.writeFileSync(path.join(__dirname,'video-gesture-preload.cjs'),"'use strict';\nconst {ipcRenderer}=require('electron');\n{const module={exports:{}};\n"+core+"\nif(process.isMainFrame)window.addEventListener('DOMContentLoaded',()=>{module.exports(document,delta=>ipcRenderer.send('neko-video-site-drag',delta),{trustedOnly:true});const style=document.createElement('style');style.textContent='html[data-hold-dragging],html[data-hold-dragging] *{cursor:grabbing!important;user-select:none!important}';document.head.append(style);});\n}\n");
