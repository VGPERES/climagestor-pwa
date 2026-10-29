export const TYPES=['clients','quotes','services','receivables','payments'];
export const blank=()=>Object.fromEntries(TYPES.map(x=>[x,[]]));
export const id=()=>crypto.randomUUID();
export const today=(d=new Date())=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export const cents=n=>Math.round((Number(n)||0)*100);
export const amt=n=>Math.round(n)/100;
export const cash=n=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(n)||0);
export const dateFmt=v=>/^\d{4}-\d\d-\d\d$/.test(v||'')?v.split('-').reverse().join('/'):'—';
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const active=(db,k)=>db[k].filter(x=>!x.deletedAt);
export const find=(db,k,key)=>db[k].find(x=>x.id===key&&!x.deletedAt);
export const name=(db,key)=>db.clients.find(x=>x.id===key)?.name||'Cliente indisponível';
export const stamp=(v)=>({...v,_rev:id(),_updatedAt:new Date().toISOString()});
export const created=v=>stamp({id:id(),...v});
export const paid=(db,rid)=>db.payments.filter(x=>x.receivableId===rid).reduce((a,x)=>a+cents(x.amount),0);
export const balance=(db,r)=>cents(r.value)-paid(db,r.id);
export const status=(db,r,asOf=today())=>{const p=paid(db,r.id),v=cents(r.value);if(v>0&&p>=v)return'Pago';if(r.due<asOf)return p?'Parcial / Vencido':'Vencido';return p?'Parcial':'Pendente'};
export function normalize(data){
  const db=blank();
  for(const k of TYPES){if(data?.[k]!==undefined&&!Array.isArray(data[k]))throw Error('Coleção inválida: '+k);
    const ids=new Set();for(const x of (data?.[k]||[])){
      if(!x||typeof x.id!=='string'||!/^[\w-]{3,150}$/.test(x.id)||ids.has(x.id))throw Error('ID inválido ou duplicado em '+k);
      ids.add(x.id);const r={...x};if(k==='services'&&r.status==='Concluída')r.status='Finalizada';
      r._rev||=id();r._updatedAt||=new Date().toISOString();db[k].push(r);
    }
  }
  // Migração do app antigo (uma baixa íntegra por recebível legado com status Pago).
  for(const r of db.receivables){if(r.status==='Pago'&&!db.payments.some(p=>p.legacyReceivableId===r.id))db.payments.push(created({receivableId:r.id,legacyReceivableId:r.id,date:r.paidDate||r.due||today(),amount:Number(r.value)||0,method:'Migração ClimaGestor v1',type:'payment',notes:'Pagamento importado do backup antigo'}));}
  return db;
}
export function validate(data){const db=normalize(data);for(const k of ['quotes','services','receivables'])for(const r of db[k])if(r.clientId&&!db.clients.some(x=>x.id===r.clientId))throw Error('Cliente vinculado não encontrado: '+k);
  for(const p of db.payments)if(!db.receivables.some(r=>r.id===p.receivableId)||!Number.isFinite(Number(p.amount)))throw Error('Lançamento financeiro inválido');
  for(const r of db.receivables)if(!Number.isFinite(Number(r.value))||cents(r.value)<0)throw Error('Cobrança com valor inválido');
  for(const r of db.receivables)if(paid(db,r.id)>cents(r.value))throw Error('Pagamentos acima do valor da cobrança');
  const linked=new Set();for(const r of db.receivables.filter(x=>!x.deletedAt&&x.sourceServiceId)){if(linked.has(r.sourceServiceId))throw Error('Cobranças duplicadas na manutenção '+r.sourceServiceId);linked.add(r.sourceServiceId)}
  return db;}
export function put(db,kind,entry,key=null){
  const prev=key?find(db,kind,key):null;if(key&&!prev)throw Error('Registro não encontrado');
  if(!['clients','quotes','services','receivables'].includes(kind))throw Error('Apenas lançamentos não financeiros podem ser editados');
  if(kind==='clients'&&!entry.name?.trim())throw Error('Informe o cliente');
  if(kind!=='clients'&&!find(db,'clients',entry.clientId))throw Error('Selecione cliente válido');
  if('value'in entry&&(!Number.isFinite(Number(entry.value))||Number(entry.value)<0))throw Error('Valor inválido');
  if(kind==='quotes'){
    if(!['Em análise','Aprovado','Recusado'].includes(entry.status))throw Error('Status inválido');
    if(entry.status==='Aprovado'&&(!entry.kind||!entry.serviceDate))throw Error('Preencha tipo e data do serviço para aprovar');
    const service=active(db,'services').find(s=>s.sourceQuoteId===key);
    if(service&&prev&&entry.status==='Aprovado'&&(entry.kind!==prev.kind||entry.serviceDate!==prev.serviceDate||cents(entry.value)!==cents(prev.value)))throw Error('Orçamento convertido: altere os dados na manutenção vinculada');
    if(service&&entry.status!=='Aprovado'&&service.status!=='Cancelada')throw Error('Cancele primeiro a manutenção originada deste orçamento');
  }
  if(kind==='services'){
    if(!entry.date||!['Agendada','Em andamento','Finalizada','Cancelada'].includes(entry.status))throw Error('Data/status inválidos');
    const linked=active(db,'receivables').find(r=>r.sourceServiceId===key);
    if(linked&&paid(db,linked.id)>0&&prev&&(cents(entry.value)!==cents(prev.value)||entry.clientId!==prev.clientId))throw Error('Há pagamento: não altere retroativamente valor ou cliente');
    if(linked&&paid(db,linked.id)>0&&entry.status!=='Finalizada')throw Error('Há pagamento vinculado: mantenha o serviço finalizado e use estorno para correção financeira');
    if(linked&&entry.status==='Cancelada')throw Error('Antes de cancelar, resolva a cobrança vinculada');
  }
  if(kind==='receivables'){
    if(!entry.due||cents(entry.value)<=0)throw Error('Informe vencimento e valor positivo');
    if(prev&&db.payments.some(p=>p.receivableId===key)&&(cents(entry.value)!==cents(prev.value)||entry.clientId!==prev.clientId))throw Error('Cobrança com movimentação financeira não pode mudar valor/cliente');
    if(entry.sourceServiceId){const srv=find(db,'services',entry.sourceServiceId);if(!srv||srv.clientId!==entry.clientId)throw Error('Serviço vinculado inválido');
      if(active(db,'receivables').some(r=>r.sourceServiceId===entry.sourceServiceId&&r.id!==key))throw Error('Já existe cobrança desse serviço');}
  }
  const next=stamp(prev?{...prev,...entry}:{id:id(),...entry});if(prev)db[kind].splice(db[kind].indexOf(prev),1,next);else db[kind].unshift(next);
  if(kind==='quotes'&&next.status==='Aprovado'&&!active(db,'services').some(s=>s.sourceQuoteId===next.id))db.services.unshift(created({sourceQuoteId:next.id,clientId:next.clientId,date:next.serviceDate,kind:next.kind,equipment:next.equipment||'',address:find(db,'clients',next.clientId)?.address||'',technician:'',status:'Agendada',value:Number(next.value)||0,cost:0,notes:'Gerado do orçamento: '+(next.description||''),preventiveReturnDate:next.preventiveReturnDate||''}));
  if(kind==='services'&&next.status==='Finalizada'&&cents(next.value)>0){const existing=active(db,'receivables').find(r=>r.sourceServiceId===next.id);
    if(!existing)db.receivables.unshift(created({sourceServiceId:next.id,clientId:next.clientId,description:`${next.kind}: ${next.equipment||'serviço'}`,due:next.date,value:Number(next.value),notes:'Cobrança gerada na conclusão'}));
    else if(!db.payments.some(p=>p.receivableId===existing.id))Object.assign(existing,stamp({...existing,value:Number(next.value),clientId:next.clientId}));}
  return next;
}
export function archive(db,kind,key){if(!['clients','quotes','services','receivables'].includes(kind))throw Error('Pagamentos não podem ser apagados');const r=find(db,kind,key);if(!r)throw Error('Registro não encontrado');
  if(kind==='clients'&&['quotes','services','receivables'].some(k=>active(db,k).some(x=>x.clientId===key)))throw Error('Cliente possui históricos; mantenha seu cadastro');
  if(kind==='quotes'&&active(db,'services').some(s=>s.sourceQuoteId===key))throw Error('Orçamento possui manutenção vinculada');
  if(kind==='services'&&active(db,'receivables').some(x=>x.sourceServiceId===key))throw Error('Manutenção possui cobrança vinculada');
  if(kind==='receivables'&&db.payments.some(x=>x.receivableId===key))throw Error('Cobrança possui histórico financeiro e não pode ser apagada');
  Object.assign(r,stamp({...r,deletedAt:new Date().toISOString()}));return r;}
export function payment(db,rid,value,date=today(),method='Pix',notes=''){const r=find(db,'receivables',rid);if(!r)throw Error('Cobrança não encontrada');const x=cents(value);if(!Number.isFinite(Number(value))||x<=0||x>balance(db,r))throw Error('Valor fora do saldo disponível');if(!/^\d{4}-\d\d-\d\d$/.test(date))throw Error('Data inválida');const p=created({receivableId:rid,amount:amt(x),date,method,notes,type:'payment'});db.payments.unshift(p);return p;}
export function reversal(db,pid,reason){const p=db.payments.find(x=>x.id===pid&&x.type!=='reversal');if(!p||db.payments.some(x=>x.reversalOf===pid))throw Error('Pagamento inexistente ou já estornado');if(!reason?.trim())throw Error('Informe o motivo');const r=created({receivableId:p.receivableId,amount:amt(-cents(p.amount)),date:today(),method:p.method,type:'reversal',reversalOf:pid,notes:reason.trim()});db.payments.unshift(r);return r;}
export function totals(db,start=today().slice(0,7)+'-01',end=today(),now=today()){
 const services=active(db,'services').filter(x=>x.date>=start&&x.date<=end),done=services.filter(x=>x.status==='Finalizada'),future=active(db,'services').filter(s=>s.status==='Agendada'&&s.date>now),open=active(db,'receivables'),receipts=db.payments.filter(p=>p.date>=start&&p.date<=end).reduce((n,p)=>n+cents(p.amount),0),value=done.reduce((n,p)=>n+cents(p.value),0),cost=done.reduce((n,p)=>n+cents(p.cost),0);
 return {services:services.length,completed:done.length,clients:active(db,'clients').length,received:amt(receipts),receivedToday:amt(db.payments.filter(p=>p.date===now).reduce((n,p)=>n+cents(p.amount),0)),open:amt(open.reduce((n,r)=>n+Math.max(0,balance(db,r)),0)),late:amt(open.filter(r=>r.due<now).reduce((n,r)=>n+Math.max(0,balance(db,r)),0)),future:future.length,projected:amt(future.reduce((n,s)=>n+cents(s.value),0)),futureBilled:amt(open.filter(r=>r.due>now).reduce((n,r)=>n+Math.max(0,balance(db,r)),0)),revenue:amt(value),cost:amt(cost),profit:amt(value-cost),approved:amt(active(db,'quotes').filter(q=>q.status==='Aprovado'&&q.date>=start&&q.date<=end).reduce((n,q)=>n+cents(q.value),0))};}
// Three-way merge: nunca sobrescreve alterações concorrentes sem escolha explícita.
export function merge(base,local,remote,choices={}){const out=blank(),conflicts=[];for(const k of TYPES){const maps=[base,local,remote].map(o=>new Map((o?.[k]||[]).map(v=>[v.id,v]))),keys=new Set([...maps[0].keys(),...maps[1].keys(),...maps[2].keys()]);for(const key of keys){const [b,l,r]=maps.map(m=>m.get(key)),rev=x=>x?x._rev||JSON.stringify(x):'nil',lc=rev(l)!==rev(b),rc=rev(r)!==rev(b);let v;if(lc&&rc&&rev(l)!==rev(r)){const c=choices[k+':'+key];if(c==='local')v=l;else if(c==='remote')v=r;else{conflicts.push({key:k+':'+key,kind:k,id:key,local:l,remote:r});continue;}}else v=lc?l:r;if(v)out[k].push(structuredClone(v));}out[k].sort((a,b)=>a.id.localeCompare(b.id));}return {db:out,conflicts};}
export function csv(rows,fields){const cell=x=>{let s=String(x??'');if(/^\s*[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'};return'\ufeff'+[fields.map(cell).join(';'),...rows.map(x=>fields.map(k=>cell(x[k])).join(';'))].join('\r\n');}
