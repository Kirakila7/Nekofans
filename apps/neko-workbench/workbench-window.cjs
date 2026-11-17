'use strict';

// Native window coordinates and display work areas are DIP. Keep the taskbar
// and the standard Windows resize/caption controls available on smaller screens.
function workbenchWindowOptions(platform, workArea, dark = false) {
  const valid = workArea && ['x','y','width','height'].every(key => Number.isFinite(workArea[key])) && workArea.width > 0 && workArea.height > 0;
  if (platform === 'darwin') {
    if (!valid) return { width:1100, height:780, minWidth:800, minHeight:560 };
    const width = Math.min(1100, Math.floor(workArea.width)), height = Math.min(780, Math.floor(workArea.height));
    return { width, height, minWidth:Math.min(800,width), minHeight:Math.min(560,height),
      x:Math.round(workArea.x+(workArea.width-width)/2), y:Math.round(workArea.y+(workArea.height-height)/2) };
  }
  if (platform !== 'win32') return { width:1100, height:780, minWidth:800, minHeight:560 };
  const area = valid ? workArea : { x:0, y:0, width:1180, height:820 };
  const width = Math.min(1180, Math.floor(area.width)), height = Math.min(800, Math.floor(area.height));
  return { width, height, minWidth:Math.min(800,width), minHeight:Math.min(560,height),
    x:Math.round(area.x+(area.width-width)/2), y:Math.round(area.y+(area.height-height)/2),
    frame:true, autoHideMenuBar:true, titleBarStyle:'hidden', titleBarOverlay:windowOverlay(dark) };
}
function windowOverlay(dark) { return { height:36, color:dark ? '#131c27' : '#ffffff', symbolColor:dark ? '#dce8f3' : '#53637c' }; }
function updateWorkbenchWindowTheme(window, dark) {
  if(typeof dark !== 'boolean')throw new TypeError('Window theme must be a boolean');
  if(process.platform==='win32'&&window&&!window.isDestroyed())window.setTitleBarOverlay(windowOverlay(dark));
}
module.exports = { workbenchWindowOptions, updateWorkbenchWindowTheme };
