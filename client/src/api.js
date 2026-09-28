//const API_URL=import.meta.env.VITE_API_URL||'http://localhost:5000/api';
const API_URL=import.meta.env.VITE_API_URL ||  '/api';
let accessToken=null;

function deviceId(){let id=localStorage.getItem('consulthub_device_id');if(!id){id=crypto.randomUUID?.()||`${Date.now()}-${Math.random()}`;localStorage.setItem('consulthub_device_id',id);}return id;}
function deviceHeaders(){return {'X-Device-Id':deviceId(),'X-Device-Name':`${navigator.platform||'Browser'} · ${navigator.userAgent.includes('Edg')?'Edge':navigator.userAgent.includes('Chrome')?'Chrome':navigator.userAgent.includes('Firefox')?'Firefox':'Browser'}`};}
export function getToken(){return accessToken;}
export function setSession(token,user){accessToken=token;sessionStorage.setItem('consulthub_user',JSON.stringify(user));}
export function clearSession(){accessToken=null;sessionStorage.removeItem('consulthub_user');}
export function getStoredUser(){try{return JSON.parse(sessionStorage.getItem('consulthub_user'));}catch{return null;}}
export async function refreshSession(){const r=await fetch(`${API_URL}/auth/refresh`,{method:'POST',credentials:'include',headers:deviceHeaders()});if(!r.ok){clearSession();return null;}const d=await r.json();setSession(d.token,d.user);return d;}
export async function logoutSession(){try{await fetch(`${API_URL}/auth/logout`,{method:'POST',credentials:'include',headers:deviceHeaders()});}finally{clearSession();}}
export async function api(path,options={},retry=true){
  const headers={'Content-Type':'application/json',...deviceHeaders(),...(accessToken?{Authorization:`Bearer ${accessToken}`}:{ }),...(options.headers||{})};
  const response=await fetch(`${API_URL}${path}`,{...options,credentials:'include',headers});
  if(response.status===401&&retry){const refreshed=await refreshSession();if(refreshed)return api(path,options,false);}
  const data=await response.json().catch(()=>({}));if(!response.ok){const e=new Error(data.message||'Request failed.');e.status=response.status;e.data=data;throw e;}return data;
}
export async function uploadBinary(path,blob,tokenOverride=null){
  const token=tokenOverride||accessToken;const response=await fetch(`${API_URL}${path}`,{method:'PUT',credentials:'include',headers:{...deviceHeaders(),...(token?{Authorization:`Bearer ${token}`}:{ }),'Content-Type':blob.type||'application/octet-stream'},body:blob});
  const data=await response.json().catch(()=>({}));if(!response.ok){const e=new Error(data.message||'Upload failed.');e.data=data;throw e;}return data;
}
export const apiBase=()=>API_URL;
//export const wsUrl=()=>import.meta.env.VITE_WS_URL||'ws://localhost:5000/ws/consultations';
export const wsUrl = () => {

  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }

  const protocol =
    window.location.protocol === 'https:'
      ? 'wss:'
      : 'ws:';

  return (
    `${protocol}//` +
    `${window.location.host}` +
    `/ws/consultations`
  );

};

export async function uploadRaw(path,blob,extraHeaders={}){
  const response=await fetch(`${API_URL}${path}`,{method:'PUT',credentials:'include',headers:{...deviceHeaders(),...(accessToken?{Authorization:`Bearer ${accessToken}`}:{ }),'Content-Type':blob.type||'application/octet-stream',...extraHeaders},body:blob});
  const data=await response.json().catch(()=>({}));if(!response.ok){const e=new Error(data.message||'Upload failed.');e.data=data;throw e;}return data;
}
