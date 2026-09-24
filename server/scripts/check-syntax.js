const fs=require('fs');const path=require('path');const {spawnSync}=require('child_process');
const roots=[path.join(__dirname,'..','src'),__dirname];const files=[];
function walk(dir){for(const name of fs.readdirSync(dir)){const p=path.join(dir,name);const st=fs.statSync(p);if(st.isDirectory())walk(p);else if(name.endsWith('.js')&&!name.endsWith('check-syntax.js'))files.push(p)}}
roots.forEach(walk);for(const file of files){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1)}console.log(`Syntax check passed for ${files.length} JavaScript files.`);
