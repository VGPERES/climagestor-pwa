/*
 * Sessão opcional em dispositivo confiável: chave AES-GCM não exportável
 * guardada pelo próprio navegador no IndexedDB. Ela dificulta exposição
 * casual do token em repouso, MAS NÃO protege contra scripts maliciosos
 * executados nesta origem, malware ou alguém com acesso ao perfil aberto.
 * Nunca publique tokens no repositório público.
 */
const enc=new TextEncoder(), dec=new TextDecoder();
export async function protectCredentials({owner,repo,token,password}){
  if(!owner||!repo||!token||!password)throw Error('Credenciais incompletas');
  if(!globalThis.crypto?.subtle)throw Error('Navegador sem Web Crypto para salvar a sessão');
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,enc.encode(JSON.stringify({owner,repo,token,password})));
  return {version:1,owner,repo,key,iv:Array.from(iv),ciphertext:Array.from(new Uint8Array(ciphertext))};
}
export async function revealCredentials(saved){
  if(!saved||saved.version!==1||!saved.key||!Array.isArray(saved.iv)||!Array.isArray(saved.ciphertext))throw Error('Sessão local incompatível');
  const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(saved.iv)},saved.key,new Uint8Array(saved.ciphertext));
  const info=JSON.parse(dec.decode(clear));
  if(info.owner!==saved.owner||info.repo!==saved.repo)throw Error('Sessão local alterada');
  return info;
}
