'use strict';
if (typeof document.createDocumentFragment === 'function') {
  const layout = document.getElementById('full-interaction');
  if (layout) document.querySelector('main').replaceWith(layout.content.cloneNode(true));
'use strict';
const facts=[
 ['SQLite','SQLite 直接在应用进程内读写本地文件，部署时无需单独的数据库服务器进程。','Serverless','https://www.sqlite.org/serverless.html'],
 ['SQLite','每个数据库文件同一时刻只有一个写入者。大量客户端同时通过网络直接读写同一数据库时，官方建议考虑客户端／服务端引擎。','When to use','https://www.sqlite.org/whentouse.html'],
 ['PostgreSQL','应用通过客户端连接数据库服务进程。服务器可以处理多个并发客户端连接。','Architecture','https://www.postgresql.org/docs/current/tutorial-arch.html'],
 ['PostgreSQL','MVCC 支持事务快照。在查询与普通写入之间，读写互不阻塞；相互冲突的写入仍可能等待。','Concurrency','https://www.postgresql.org/docs/current/mvcc-intro.html']
];
const by=id=>document.getElementById(id);
function draw(){
  const p=window.pickDatabase(by('local').checked,by('shared').checked);
  by('tag').textContent=p.tag;
  by('choice').textContent=p.title;
  by('reason').textContent=p.reason;
  const chain=document.createElement('div');
  chain.className='diagram';

  // 双选时绘制分层拓扑：现场 → 同步通道 → 中心服务
  if (by('local').checked && by('shared').checked) {
    const nodes = [
      {label:'现场 SQLite', cls:'node-local'},
      {label:'同步通道', cls:'node-sync'},
      {label:'中心 PostgreSQL', cls:'node-center'}
    ];
    nodes.forEach((n,i)=>{
      if(i){
        const arrow=document.createElement('i');
        arrow.textContent='⇌';
        arrow.className='sync-arrow';
        chain.append(arrow);
      }
      const node=document.createElement('b');
      node.textContent=n.label;
      node.className=n.cls;
      chain.append(node);
    });
    // 附加说明
    const note=document.createElement('small');
    note.className='sync-note';
    note.textContent='同步需另行实现：可重试、去重、冲突处理';
    chain.append(note);
  } else {
    // 原有逻辑
    p.path.forEach((v,i)=>{
      if(i){const a=document.createElement('i');a.textContent='→';chain.append(a)}
      const node=document.createElement('b');node.textContent=v;chain.append(node)
    });
  }
  by('topology').replaceChildren(chain);
}
function filter(group){const els=facts.filter(f=>group==='all'||f[0]===group).map(([name,copy,label,url])=>{const div=document.createElement('article');div.className='fact';const b=document.createElement('b'),p=document.createElement('p'),a=document.createElement('a');b.textContent=name;p.textContent=copy;a.textContent=label+' ↗';a.href=url;a.target='_blank';a.rel='noopener noreferrer';div.append(b,p,a);return div;});by('evidence').replaceChildren(...els);for(const btn of by('filters').children)btn.setAttribute('aria-pressed',String(btn.dataset.f===group));}
by('local').addEventListener('change',draw);by('shared').addEventListener('change',draw);for(const btn of by('filters').children)btn.addEventListener('click',()=>filter(btn.dataset.f));draw();filter('all');
}
