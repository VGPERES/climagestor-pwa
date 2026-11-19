import {TYPES,blank,id,today,cents,amt,cash,dateFmt,esc,active,find,name,stamp,created,paid,balance,status,normalize,validate,put,archive,payment,reversal,totals,csv} from './model.js';
import {GitHubSync} from './sync.js';
import {protectCredentials,revealCredentials} from './credentials.js';
const $=k=>document.getElementById(k);
const base=blank();let db=blank(),baseline=blank(),persistBusy=Promise.resolve(),syncClient=null,syncBusy=false,saveTimer=0,editKind='',editKey=null,payId=null,reversalId=null,lastSynced='Nunca',syncBinding='',syncVerified=false,lastSyncError='',conflictChoices={};
const KEY='climagestor_v2';
const schemes={
 client:{title:'Cliente',items:[['name','Nome / Razão social','text',1],['phone','Telefone / WhatsApp','tel'],['email','E-mail','email'],['address','Endereço','text'],['notes','Observações','textarea']]},
 service:{title:'Manutenção',items:[['date','Data da visita','date',1],['clientId','Cliente','client',1],['kind','Tipo de serviço','select:Preventiva|Corretiva|Higienização|Instalação|Avaliação técnica',1],['equipment','Equipamento / capacidade','text'],['address','Local do atendimento','text'],['technician','Técnico responsável','text'],['status','Status','select:Agendada|Em andamento|Finalizada|Cancelada',1],['value','Valor do serviço (R$)','number'],['cost','Custos (R$)','number'],['preventiveReturnDate','Próximo retorno preventivo','date'],['notes','Checklist / observações','textarea']]},
 quote:{title:'Orçamento',items:[['clientId','Cliente','client',1],['description','Descrição / escopo','textarea',1],['date','Data do orçamento','date',1],['validity','Validade até','date',1],['kind','Tipo de serviço','select:Preventiva|Corretiva|Higienização|Instalação|Avaliação técnica',1],['serviceDate','Data prevista da visita','date'],['equipment','Equipamento / capacidade','text'],['value','Valor total (R$)','number',1],['status','Status','select:Em análise|Aprovado|Recusado',1],['preventiveReturnDate','Retorno preventivo','date'],['notes','Condições / observações','textarea']]},
 receivable:{title:'Cobrança',items:[['clientId','Cliente','client',1],['sourceServiceId','Manutenção vinculada (opcional)','service'],['description','Descrição','text',1],['due','Vencimento','date',1],['value','Valor (R$)','number',1],['notes','Observações','textarea']]}
};
function dbStore(){return new Promise((resolve,reject)=>{let req=indexedDB.open('climagestor_db_v2',2);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('data'))req.result.createObjectStore('data');if(!req.result.objectStoreNames.contains('auth'))req.result.createObjectStore('auth');};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(Error('Feche outras abas antigas do ClimaGestor para atualizar o armazenamento'));});}
async function readStore(){const store=await dbStore();return new Promise((resolve,reject)=>{let t=store.transaction('data','readonly'),r=t.objectStore('data').get(KEY);r.onsuccess=()=>{resolve(r.result);store.close()};r.onerror=()=>{reject(r.error);store.close()};});}
async function writeStore(value){const store=await dbStore();return new Promise((resolve,reject)=>{let t=store.transaction('data','readwrite');t.objectStore('data').put(value,KEY);t.oncomplete=()=>{store.close();resolve()};t.onerror=()=>{store.close();reject(t.error)};});}
// Só neste dispositivo: armazenar ou apagar a sessão de sincronização.
async function authStore(action,value){const store=await dbStore();return new Promise((resolve,reject)=>{const t=store.transaction('auth',action==='get'?'readonly':'readwrite');let req=t.objectStore('auth');if(action==='get')req=req.get('github-sync');else if(action==='delete')req.delete('github-sync');else req.put(value,'github-sync');let result=null;if(action==='get')req.onsuccess=()=>{result=req.result};t.oncomplete=()=>{store.close();resolve(result)};t.onerror=()=>{store.close();reject(t.error)};t.onabort=()=>{store.close();reject(t.error||Error('Falha na sessão local'))};});}
const sessionSnapshot=()=>({db,baseline,syncBinding,lastSynced,modifiedAt:new Date().toISOString()});
function countDiff(){let n=0;for(const k of TYPES){const m=new Map(baseline[k].map(x=>[x.id,x._rev]));for(const x of db[k])if(m.get(x.id)!==x._rev)n++;}return n;}
function syncState(msg=''){
 const n=countDiff(),mode=syncClient?(syncVerified?'Conectado':'Configurado (aguardando confirmação)'):'Desconectado';
 const text=`${mode} · ${n} alteração(ões) local(is) pendente(s) · Última confirmação: ${lastSynced}`;
 const display=syncBusy?'Sincronizando...':lastSyncError?'FALHA: '+lastSyncError+' · '+text:msg||text;
 if($('syncState'))$('syncState').textContent=display;
 if($('sideSyncState'))$('sideSyncState').textContent=display;
 if($('cloudStatus'))$('cloudStatus').innerHTML='<strong>'+esc(display)+'</strong>';
}
async function commit(){persistBusy=persistBusy.catch(()=>{}).then(()=>writeStore(sessionSnapshot()));await persistBusy;renderAll();syncState();if(syncClient){clearTimeout(saveTimer);saveTimer=setTimeout(()=>syncNow(),1600)}}
async function initialize(){try{const state=await readStore();if(state?.db){db=validate(state.db);baseline=validate(state.baseline||blank());syncBinding=state.syncBinding||'';lastSynced=state.lastSynced||'Nunca';}
 else {const legacy=localStorage.getItem('climagemanager_db_v1');if(legacy){db=validate(JSON.parse(legacy));await writeStore(sessionSnapshot());showNotice('Dados antigos importados deste navegador. Faça backup antes de sincronizar.');}else await writeStore(sessionSnapshot());}
 renderAll();syncState();await autoReconnect();}catch(e){console.error(e);alert('Falha ao carregar armazenamento: '+e.message);lastSyncError='Armazenamento local não disponível; não cadastre dados';syncState();}}
async function autoReconnect(){
 let saved;try{saved=await authStore('get');}catch(e){lastSyncError='Não foi possível acessar credenciais salvas: '+e.message;syncState();return}
 if(!saved)return;
 try{
  const info=await revealCredentials(saved);
  if(syncBinding&&syncBinding!==info.owner+'/'+info.repo)throw Error('Repositório da sessão salva diferente do vinculado; configure novamente');
  syncClient=new GitHubSync(info.owner,info.repo,info.token,info.password);
  $('githubOwner').value=info.owner;$('githubRepo').value=info.repo;$('rememberGithub').checked=true;
  syncState('Reconectando este dispositivo automaticamente...');
  if(navigator.onLine)await syncNow();else syncState('Sem internet: este dispositivo reconectará ao voltar a conexão');
 }catch(e){syncClient=null;lastSyncError='Não foi possível restaurar a sessão deste dispositivo: '+e.message;syncState();}
}
function showNotice(message){const b=$('cloudStatus');if(b)b.innerHTML='<strong>'+esc(message)+'</strong>'}
function safeAction(fn){if(syncBusy){alert('Sincronização em andamento. Conclua a operação antes de alterar registros.');return}try{const result=fn();Promise.resolve(result).catch(e=>alert(e.message))}catch(e){alert(e.message)}}
function showPage(page){document.querySelectorAll('.page').forEach(el=>el.classList.toggle('active',el.id==='page-'+page));document.querySelectorAll('.nav button').forEach(el=>el.classList.toggle('active',el.dataset.page===page));if(page==='reports')renderReports();if(page==='spreadsheet')renderSpreadsheet();if(page==='sync')syncState();}
function clientOptions(value=''){return '<option value="">Selecione...</option>'+active(db,'clients').map(c=>`<option value="${esc(c.id)}" ${value===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}
function serviceOptions(value=''){return '<option value="">Sem vínculo</option>'+active(db,'services').map(s=>`<option value="${esc(s.id)}" ${value===s.id?'selected':''}>${esc(name(db,s.clientId))} · ${dateFmt(s.date)} · ${esc(s.kind)}</option>`).join('')}
function openModal(kind,key=null){if(syncBusy)return alert('Aguarde a sincronização');editKind=kind;editKey=key;
 const config=schemes[kind];if(!config)return;const data=key?find(db,kind+'s',key):{};if(key&&!data)return alert('Registro não encontrado');
 $('modalTitle').textContent=(key?'Editar ':'Novo ')+config.title;
 $('formFields').innerHTML=config.items.map(([n,label,type,required])=>{const def=n==='date'?today():n==='validity'?today():n==='status'?{service:'Agendada',quote:'Em análise'}[kind]:'';const v=data?.[n]??def??'';let el;if(type==='textarea')el=`<textarea name="${n}" ${required?'required':''}>${esc(v)}</textarea>`;
 else if(type==='client')el=`<select name="${n}" ${required?'required':''}>${clientOptions(v)}</select>`;
 else if(type==='service')el=`<select name="${n}">${serviceOptions(v)}</select>`;
 else if(type.startsWith('select:'))el=`<select name="${n}" ${required?'required':''}>${type.slice(7).split('|').map(o=>`<option ${o===v?'selected':''}>${esc(o)}</option>`).join('')}</select>`;
 else el=`<input type="${type}" name="${n}" value="${esc(v)}" ${required?'required':''} ${type==='number'?'min="0" step="0.01"':''}>`;
 return `<div class="field ${type==='textarea'?'full':''}"><label>${esc(label)}${required?' *':''}</label>${el}</div>`;}).join('');
 $('modalBackdrop').classList.add('show');}
function openPay(rid){const r=find(db,'receivables',rid);if(!r)return;payId=rid;editKind='payment';editKey=null;$('modalTitle').textContent='Registrar pagamento';$('formFields').innerHTML=`<div class="field full"><label>Cliente / saldo</label><p>${esc(name(db,r.clientId))} — ${cash(amt(balance(db,r)))}</p></div><div class="field"><label>Valor recebido</label><input name="amount" type="number" required min="0.01" step="0.01" max="${amt(balance(db,r))}" value="${amt(balance(db,r))}"></div><div class="field"><label>Data</label><input name="date" type="date" required value="${today()}"></div><div class="field"><label>Meio</label><select name="method"><option>Pix</option><option>Dinheiro</option><option>Cartão</option><option>Transferência</option><option>Outro</option></select></div><div class="field full"><label>Observações</label><textarea name="notes"></textarea></div>`;$('modalBackdrop').classList.add('show');}
function closeModal(){$('modalBackdrop').classList.remove('show');editKind='';editKey=null;payId=null;}
async function saveModal(evt){evt.preventDefault();if(syncBusy)return alert('Sincronização em andamento');let fields=Object.fromEntries(new FormData(evt.currentTarget).entries());try{
 if(editKind==='payment'){payment(db,payId,Number(fields.amount),fields.date,fields.method,fields.notes);}
 else {if('value'in fields)fields.value=Number(fields.value)||0;if('cost'in fields)fields.cost=Number(fields.cost)||0;
 if(editKind==='service'&&!fields.address)fields.address=find(db,'clients',fields.clientId)?.address||'';
 put(db,editKind+'s',fields,editKey);}
 closeModal();await commit();}catch(e){alert(e.message)}}
function archiveRow(k,key){safeAction(async()=>{if(!confirm('Arquivar este registro? Dados financeiros e referências vinculadas serão preservados.'))return;archive(db,k+'s',key);await commit()})}
function reverseRow(key){safeAction(async()=>{const reason=prompt('Motivo obrigatório do estorno (o histórico permanece):');if(reason===null)return;reversal(db,key,reason);await commit()})}
const actions=(k,r,additional='')=>`<div class="actions"><button class="smallbtn" onclick="openModal('${k}','${r.id}')">Editar</button><button class="smallbtn danger" onclick="archiveRow('${k}','${r.id}')">Arquivar</button>${additional}</div>`;
const badge=s=>{const colors={'Finalizada':'green','Pago':'green','Aprovado':'green','Agendada':'blue','Em andamento':'orange','Em análise':'orange','Pendente':'orange','Parcial':'orange','Parcial / Vencido':'red','Vencido':'red','Cancelada':'red','Recusado':'red'};return `<span class="pill ${colors[s]||''}">${esc(s||'—')}</span>`};
function renderClients(){const q=($('clientSearch')?.value||'').toLowerCase(),rows=active(db,'clients').filter(c=>[c.name,c.phone,c.email,c.address].join(' ').toLowerCase().includes(q));$('clientsTable').innerHTML=rows.map(c=>`<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.phone||'—')}</td><td>${esc(c.email||'—')}</td><td>${esc(c.address||'—')}</td><td>${actions('client',c)}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">Nenhum cliente.</td></tr>';}
function renderServices(){const q=($('serviceSearch')?.value||'').toLowerCase(),f=$('serviceFilter')?.value||'';const rows=active(db,'services').filter(s=>(!f||s.status===f)&&[name(db,s.clientId),s.equipment,s.technician,s.kind,s.address].join(' ').toLowerCase().includes(q)).sort((a,b)=>a.date.localeCompare(b.date));$('servicesTable').innerHTML=rows.map(s=>`<tr><td>${dateFmt(s.date)}</td><td><strong>${esc(name(db,s.clientId))}</strong><br><span class="muted">${esc(s.address||'')}</span></td><td>${esc(s.kind)}</td><td>${esc(s.equipment||'—')}</td><td>${esc(s.technician||'—')}</td><td>${badge(s.status)}</td><td>${actions('service',s)}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">Nenhuma manutenção.</td></tr>';}
function renderQuotes(){const q=($('quoteSearch')?.value||'').toLowerCase(),f=$('quoteFilter')?.value||'';const rows=active(db,'quotes').filter(x=>(!f||x.status===f)&&[name(db,x.clientId),x.description].join(' ').toLowerCase().includes(q)).sort((a,b)=>a.id.localeCompare(b.id));$('quotesTable').innerHTML=rows.map(x=>`<tr><td><strong>ORC-${esc(x.id.slice(0,8).toUpperCase())}</strong></td><td>${esc(name(db,x.clientId))}</td><td>${esc(x.description)}${x.serviceDate?`<br><span class="muted">Visita: ${dateFmt(x.serviceDate)}</span>`:''}</td><td>${dateFmt(x.validity)}</td><td>${cash(x.value)}</td><td>${badge(x.status)}</td><td>${actions('quote',x)}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">Nenhum orçamento.</td></tr>';}
function renderReceivables(){const q=($('receivableSearch')?.value||'').toLowerCase(),f=$('receivableFilter')?.value||'';const rows=active(db,'receivables').filter(r=>(!f||status(db,r)===f)&&[name(db,r.clientId),r.description].join(' ').toLowerCase().includes(q)).sort((a,b)=>a.due.localeCompare(b.due));$('receivablesTable').innerHTML=rows.map(r=>`<tr><td>${dateFmt(r.due)}</td><td>${esc(name(db,r.clientId))}</td><td>${esc(r.description||'')}</td><td>${cash(r.value)}</td><td><strong>${cash(amt(Math.max(0,balance(db,r))))}</strong></td><td>${badge(status(db,r))}</td><td>${actions('receivable',r,balance(db,r)>0?`<button class="smallbtn" onclick="openPay('${r.id}')">Receber</button>`:'')}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">Nenhuma cobrança.</td></tr>';}
function renderPayments(){const rows=db.payments.slice().sort((a,b)=>b.date.localeCompare(a.date));$('paymentsTable').innerHTML=rows.map(p=>{const r=db.receivables.find(x=>x.id===p.receivableId);return `<tr><td>${dateFmt(p.date)}</td><td>${esc(r?name(db,r.clientId):'—')}</td><td>${esc(r?.description||'—')}</td><td>${badge(p.type==='reversal'?'Estorno':'Pagamento')}</td><td>${esc(p.method||'—')}</td><td>${cash(p.amount)}</td><td>${p.type==='reversal'||db.payments.some(x=>x.reversalOf===p.id)?'—':`<button class="smallbtn danger" onclick="reverseRow('${p.id}')">Estornar</button>`}</td></tr>`}).join('')||'<tr><td colspan="7" class="empty">Nenhum pagamento lançado.</td></tr>';}
function preventive(){const limit=new Date();limit.setDate(limit.getDate()+7);const threshold=today(limit),alertRows=active(db,'services').filter(s=>s.preventiveReturnDate&&s.preventiveReturnDate<=threshold&&s.status!=='Cancelada').sort((a,b)=>a.preventiveReturnDate.localeCompare(b.preventiveReturnDate));$('preventiveAlerts').style.display=alertRows.length?'block':'none';$('preventiveAlerts').innerHTML=alertRows.length?`<strong>🔔 Retornos preventivos próximos ou atrasados</strong><p>${alertRows.map(s=>`${esc(name(db,s.clientId))}: ${dateFmt(s.preventiveReturnDate)}${s.preventiveReturnDate<today()?' (ATRASADO)':''}`).join('<br>')}</p>`:'';}
function renderDashboard(){const t=totals(db);$('statServices').textContent=t.services;$('statFutureReceivable').textContent=cash(t.projected);$('statReceivedToday').textContent=cash(t.receivedToday);$('statReceived').textContent=cash(t.received);$('statReceivable').textContent=cash(t.open);$('financePending').textContent=cash(t.open);$('financePaid').textContent=cash(t.received);$('financeLate').textContent=cash(t.late);const allPaid=db.payments.reduce((a,p)=>a+cents(p.amount),0),allOpen=active(db,'receivables').reduce((a,r)=>a+Math.max(0,balance(db,r)),0),pct=allPaid+allOpen>0?Math.min(100,Math.max(0,Math.round(allPaid/(allPaid+allOpen)*100))):0;$('financeProgress').style.width=pct+'%';$('financeProgressText').textContent=`${pct}% do total lançado já recebido (histórico).`;
 const upcoming=active(db,'services').filter(s=>s.date>=today()&&['Agendada','Em andamento'].includes(s.status)).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,5);$('upcomingList').innerHTML=upcoming.map(s=>`<div class="list-row"><div class="mini-icon">❄</div><div class="row-main"><strong>${esc(name(db,s.clientId))}</strong><small>${dateFmt(s.date)} · ${esc(s.kind)} · ${cash(s.value)}</small></div>${badge(s.status)}</div>`).join('')||'<div class="empty">Nenhuma agenda futura.</div>';preventive();renderSpreadsheet();}
function renderSpreadsheet(){const t=totals(db);$('sheetReceivedToday').textContent=cash(t.receivedToday);$('sheetReceivedMonth').textContent=cash(t.received);$('sheetFutureCount').textContent=t.future;$('sheetFutureTotal').textContent=cash(t.projected);
 const srv=active(db,'services').sort((a,b)=>a.date.localeCompare(b.date));$('sheetServices').innerHTML=srv.map(s=>{const r=active(db,'receivables').find(r=>r.sourceServiceId===s.id);return `<tr><td>${esc(name(db,s.clientId))}</td><td>${dateFmt(s.date)}</td><td>${esc(s.kind)}</td><td>${cash(s.value)}</td><td>${cash(r?amt(paid(db,r.id)):0)}</td><td>${r?dateFmt(db.payments.filter(p=>p.receivableId===r.id).map(p=>p.date).sort().pop()):'—'}</td><td>${badge(r?status(db,r):s.status)}</td></tr>`}).join('')||'<tr><td colspan="7" class="empty">Nenhum serviço.</td></tr>';
 $('sheetFuture').innerHTML=srv.filter(s=>s.date>today()&&s.status==='Agendada').map(s=>{const r=active(db,'receivables').find(r=>r.sourceServiceId===s.id);const received=r?amt(paid(db,r.id)):0;return `<tr><td>${esc(name(db,s.clientId))}</td><td>${dateFmt(s.date)}</td><td>${esc(s.kind)}</td><td>${cash(s.value)}</td><td>${cash(received)}</td><td>${cash(Math.max(0,s.value-received))}</td><td>${badge(s.status)}</td></tr>`}).join('')||'<tr><td colspan="7" class="empty">Nenhuma agenda futura.</td></tr>';}
function renderReports(){const start=$('reportStart').value||today().slice(0,7)+'-01',end=$('reportEnd').value||today();if(start>end){$('reportSummary').innerHTML='<div class="notice">Período inválido.</div>';return}const t=totals(db,start,end);const stats=[['Manutenções no período',t.services],['Concluídas',t.completed],['Faturamento concluído',cash(t.revenue)],['Custos informados',cash(t.cost)],['Margem bruta estimada',cash(t.profit)],['Recebimentos efetivos',cash(t.received)]];$('reportSummary').innerHTML=stats.map(([h,v])=>`<div class="card"><h3>${h}</h3><div class="big">${v}</div></div>`).join('');const ss=active(db,'services').filter(s=>s.date>=start&&s.date<=end);$('reportServices').innerHTML=['Agendada','Em andamento','Finalizada','Cancelada'].map(s=>`<div class="list-row"><div class="row-main"><strong>${s}</strong></div><strong>${ss.filter(x=>x.status===s).length}</strong></div>`).join('');$('reportMoney').innerHTML=[['Faturamento concluído',t.revenue],['Custos de serviços concluídos',t.cost],['Margem bruta estimada',t.profit],['Efetivamente recebido',t.received],['Orçamentos aprovados no período',t.approved],['Saldo total em aberto (hoje)',t.open],['Saldo vencido (hoje)',t.late]].map(([label,v])=>`<div class="list-row"><div class="row-main"><strong>${label}</strong></div><strong>${cash(v)}</strong></div>`).join('');}
function renderAll(){renderServices();renderClients();renderQuotes();renderReceivables();renderPayments();renderDashboard();renderReports();}
function dl(content,file,type){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=file;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000)}
function downloadBackup(){dl(JSON.stringify({app:'ClimaGestor',version:2,createdAt:new Date().toISOString(),data:db},null,2),`ClimaGestor_backup_${today()}.json`,'application/json;charset=utf-8')}
async function restoreBackup(event){const file=event.target.files?.[0];if(!file)return;try{if(syncBusy)throw Error('Sincronização em andamento');const source=JSON.parse(await file.text()),newDb=validate(source.data||source);if(!confirm('IMPORTANTE: substituir dados LOCAIS e desvincular a referência anterior de sincronização? Faça backup antes. Com dados remotos diferentes poderá ser necessário resolver conflitos.'))return;db=newDb;baseline=blank();await commit();alert('Backup restaurado neste aparelho. Conecte ao GitHub para sincronizar.')}catch(err){alert('Backup rejeitado: '+err.message)}finally{event.target.value=''}}
function exportCSV(kind){let rows=[],fields=[];if(kind==='all'){rows=TYPES.flatMap(k=>db[k].map(x=>({colecao:k,...x})));fields=[...new Set(rows.flatMap(x=>Object.keys(x)))]}else{rows=db[kind]||[];fields=[...new Set(rows.flatMap(x=>Object.keys(x)))]}dl(csv(rows,fields),`ClimaGestor_${kind}_${today()}.csv`,'text/csv;charset=utf-8')}
const xmlEscape=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function xmlSheet(title,heads,rows){const row=items=>`<Row>${items.map(x=>{const n=typeof x==='number'&&Number.isFinite(x);return `<Cell><Data ss:Type="${n?'Number':'String'}">${xmlEscape(x)}</Data></Cell>`}).join('')}</Row>`;return `<Worksheet ss:Name="${title}"><Table>${row(heads)}${rows.map(row).join('')}</Table></Worksheet>`;}
function downloadSpreadsheetXls(){const t=totals(db);const srv=active(db,'services').map(s=>{const r=active(db,'receivables').find(r=>r.sourceServiceId===s.id);return[name(db,s.clientId),dateFmt(s.date),s.kind,s.value,r?amt(paid(db,r.id)):0,s.status]});const rec=active(db,'receivables').map(r=>[name(db,r.clientId),r.description,dateFmt(r.due),Number(r.value),amt(paid(db,r.id)),amt(Math.max(0,balance(db,r))),status(db,r)]);const pay=db.payments.map(p=>{const r=db.receivables.find(r=>r.id===p.receivableId);return[dateFmt(p.date),r?name(db,r.clientId):'',p.method,p.type,Number(p.amount),p.notes||'']});const xml=`<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${xmlSheet('Resumo',['Indicador','Valor'],[['Recebido hoje',t.receivedToday],['Recebido no mês',t.received],['Valor pendente',t.open],['Agenda futura estimada',t.projected],['Clientes ativos',t.clients]])}${xmlSheet('Servicos',['Cliente','Data','Tipo','Valor','Pago','Status'],srv)}${xmlSheet('Recebiveis',['Cliente','Descrição','Vencimento','Valor','Pago','Saldo','Status'],rec)}${xmlSheet('Pagamentos',['Data','Cliente','Meio','Tipo','Valor','Observações'],pay)}${xmlSheet('Clientes',['Nome','Telefone','Email','Endereço'],active(db,'clients').map(c=>[c.name,c.phone,c.email,c.address]))}</Workbook>`;dl(xml,`ClimaGestor_${today()}.xls`,'application/vnd.ms-excel;charset=utf-8')}
function renderConflict(result){const panel=$('conflictPanel');panel.style.display='block';panel.innerHTML='<h2>Alterações simultâneas: escolha por registro</h2><p class="muted-note">O programa não sobrescreveu nenhuma versão. Selecione a opção correta em cada conflito e clique em Resolver.</p>'+result.conflicts.map(c=>`<div class="conflict"><strong>${esc(c.kind)} / ${esc(c.id)}</strong><div class="grid two-col"><div><b>Este aparelho</b><pre>${esc(JSON.stringify(c.local,null,2))}</pre></div><div><b>GitHub</b><pre>${esc(JSON.stringify(c.remote,null,2))}</pre></div></div><label>Manter <select class="conflict-choice" data-key="${esc(c.key)}"><option value="">Escolha...</option><option value="local">Este aparelho</option><option value="remote">GitHub</option></select></label></div>`).join('')+'<button class="btn primary" id="resolveConflicts">Resolver e sincronizar</button>';$('resolveConflicts').onclick=()=>{const choices={};for(const el of document.querySelectorAll('.conflict-choice')){if(!el.value)return alert('Escolha uma opção para cada conflito');choices[el.dataset.key]=el.value}syncNow(choices)};showPage('sync');}
async function syncNow(choices={}){
 if(syncBusy)return false;
 if(!syncClient){showPage('sync');alert('Conecte o GitHub neste dispositivo primeiro.');return false}
 if(!navigator.onLine){syncState('Offline: alterações preservadas neste aparelho');return false}
 syncBusy=true;syncState('Consultando e conferindo versões no GitHub...');
 try{
  await persistBusy;
  const result=await syncClient.run(structuredClone(db),structuredClone(baseline),choices);
  if(result.needsDecision){renderConflict(result);lastSyncError='Conflito de alterações: selecione a versão correta abaixo';return false}
  db=validate(result.db);baseline=validate(result.baseline);
  syncBinding=syncClient.owner+'/'+syncClient.repo;
  lastSynced=new Date().toLocaleString('pt-BR');
  await writeStore(sessionSnapshot());
  lastSyncError='';syncVerified=true;
  $('conflictPanel').style.display='none';renderAll();
  return true;
 }catch(err){console.error(err);lastSyncError=err.message||String(err);if(!Object.keys(choices).length)alert('Sincronização não concluída: '+lastSyncError);return false}
 finally{syncBusy=false;syncState()}
}
async function connectGithub(e){
 e.preventDefault();if(syncBusy){alert('Aguarde a sincronização atual terminar.');return}
 const previousClient=syncClient,previousVerified=syncVerified,previousBaseline=structuredClone(baseline),previousBinding=syncBinding;
 try{
  const owner=$('githubOwner').value.trim(),repo=$('githubRepo').value.trim(),token=$('githubToken').value.trim(),password=$('githubPassword').value;
  const next=new GitHubSync(owner,repo,token,password),binding=owner+'/'+repo;
  if(syncBinding!==binding){if(syncBinding&&!confirm('O repositório de dados será alterado. Isso reinicia a referência de sincronização deste aparelho. Continuar?'))return;baseline=blank();}
  syncClient=next;syncVerified=false;lastSyncError='';
  const ok=await syncNow();
  if(!ok){syncClient=previousClient;syncVerified=previousVerified;baseline=previousBaseline;syncBinding=previousBinding;syncState();return}
  localStorage.setItem('climagestor_github_repo_v2',JSON.stringify({owner,repo}));
  if($('rememberGithub').checked){
   try{await authStore('put',await protectCredentials({owner,repo,token,password}));}
   catch(err){alert('Conectado, mas não foi possível manter a sessão neste aparelho: '+err.message)}
  }else await authStore('delete');
  $('githubToken').value='';$('githubPassword').value='';
  syncState();
 }catch(err){syncClient=previousClient;syncVerified=previousVerified;baseline=previousBaseline;syncBinding=previousBinding;lastSyncError=err.message;syncState();alert(err.message)}
}
async function disconnect(){
 if(syncBusy){alert('Aguarde a sincronização terminar antes de desconectar este aparelho.');return}
 if(countDiff()>0&&!confirm('Há alterações locais ainda não sincronizadas. Elas continuarão neste aparelho. Desconectar somente este dispositivo?'))return;
 syncClient=null;syncVerified=false;lastSyncError='';clearTimeout(saveTimer);
 $('githubToken').value='';$('githubPassword').value='';$('rememberGithub').checked=false;
 try{await authStore('delete')}catch(e){lastSyncError='Sessão local não apagada: '+e.message}
 syncState();
}

Object.assign(window,{showPage,openModal,openPay,closeModal,renderServices,renderClients,renderQuotes,renderReceivables,renderReports,renderSpreadsheet,downloadBackup,restoreBackup,archiveRow,reverseRow,exportCSV,downloadSpreadsheetXls,syncNow});
document.querySelectorAll('.nav button').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.page)));
$('todayLabel').textContent=new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'});
$('dataForm').addEventListener('submit',saveModal);$('syncForm').addEventListener('submit',connectGithub);$('disconnectGithub').onclick=disconnect;
$('reportStart').value=today().slice(0,7)+'-01';$('reportEnd').value=today();
try{const repo=JSON.parse(localStorage.getItem('climagestor_github_repo_v2')||'{}');$('githubOwner').value=repo.owner||'';$('githubRepo').value=repo.repo||'';}catch(e){}
window.addEventListener('online',()=>{if(syncClient)syncNow()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&syncClient&&navigator.onLine)syncNow()});
window.addEventListener('focus',()=>{if(syncClient&&navigator.onLine&&Date.now()-lastFocusPoll>12000){lastFocusPoll=Date.now();syncNow()}});
let lastFocusPoll=0;
window.setInterval(()=>{if(syncClient&&!syncBusy&&navigator.onLine)syncNow()},30000);
initialize();
