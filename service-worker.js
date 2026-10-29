const VERSION='climagestor-app-v2-20261029';
const APP=['./','./index.html','./app.js','./model.js','./sync.js','./manifest.json','./icon.svg','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(VERSION).then(c=>c.addAll(APP)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(names=>Promise.all(names.filter(n=>n.startsWith('climagestor-app-')&&n!==VERSION).map(n=>caches.delete(n)))));self.clients.claim()});
self.addEventListener('fetch',e=>{
  const url=new URL(e.request.url);
  if(e.request.method!=='GET'||url.origin!==self.location.origin)return;
  e.respondWith(fetch(e.request).then(resp=>{if(resp.ok){const copy=resp.clone();e.waitUntil(caches.open(VERSION).then(c=>c.put(e.request,copy)))}return resp}).catch(()=>caches.match(e.request).then(v=>v||caches.match('./index.html'))));
});
