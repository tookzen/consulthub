const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

const root=path.resolve(__dirname,'../../storage/private');
const backupRoot=path.resolve(__dirname,'../../storage/private-backup');
fs.mkdirSync(root,{recursive:true,mode:0o700});
fs.mkdirSync(backupRoot,{recursive:true,mode:0o700});

function keyFor(id){return `${id}.bin`;}
function pathFor(key,base=root){const clean=path.basename(key);return path.join(base,clean);}
async function put(id,buffer){
  const key=keyFor(id);const primary=pathFor(key);const backup=pathFor(key,backupRoot);
  await fs.promises.writeFile(primary,buffer,{mode:0o600});
  let backupStatus='BACKED_UP';let backupKey=key;
  try{await fs.promises.copyFile(primary,backup);await fs.promises.chmod(backup,0o600);}catch{backupStatus='FAILED';backupKey=null;}
  const hash=crypto.createHash('sha256').update(buffer).digest('hex');
  return{key,size:buffer.length,hash,backupKey,backupStatus};
}
async function read(key){
  try{return await fs.promises.readFile(pathFor(key));}
  catch(e){if(e.code!=='ENOENT')throw e;return fs.promises.readFile(pathFor(key,backupRoot));}
}
async function remove(key){for(const base of [root,backupRoot]){try{await fs.promises.unlink(pathFor(key,base));}catch(e){if(e.code!=='ENOENT')throw e;}}}
module.exports={put,read,remove};
