(function(root){
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const labels={active:'Active',ordered:'Ordered',taken_down:'Taken down',unknown:'Unknown',unpaid:'Unpaid',paid:'Paid',complimentary:'Complimentary'};
 const options=(values,selected)=>values.map(v=>'<option value="'+v+'" '+(v===selected?'selected':'')+'>'+labels[v]+'</option>').join('');
 const field=(label,name,value,type='text')=>'<label>'+label+'<input name="'+name+'" type="'+type+'" value="'+esc(value)+'"></label>';
 function render(data,state){
 const year=Number(state.year),payments=data.years||[];
 const filtered=data.banners.filter(b=>(state.status==='all'||b.status===state.status)&&(state.payment==='all'||(payments.find(p=>p.banner_id===b.id&&p.year===year)?.payment_status||'unknown')===state.payment)&&[b.name,b.owner,b.email,b.phone].join(' ').toLowerCase().includes(state.search.toLowerCase()));
 const years=[...new Set([new Date().getFullYear()+1,new Date().getFullYear(),year,...payments.map(p=>p.year)])].sort((a,b)=>b-a);
 return '<div class="sponsor-directory-head"><h3>Sponsor directory <span>'+data.banners.length+'</span></h3><button type="button" data-new-banner>Add banner</button></div>'+
 '<div class="sponsor-directory-controls"><label>Search<input data-directory-search value="'+esc(state.search)+'" placeholder="Banner or owner"></label><label>Year<select data-directory-year>'+years.map(y=>'<option '+(y===year?'selected':'')+'>'+y+'</option>').join('')+'</select></label><label>Banner status<select data-directory-status><option value="all">All banners</option>'+options(['active','ordered','taken_down'],state.status)+'</select></label><label>Payment<select data-directory-payment><option value="all">All payments</option>'+options(['unknown','unpaid','paid','complimentary'],state.payment)+'</select></label></div>'+
 (state.newBanner?'<form data-directory-create class="sponsor-directory-form">'+field('Banner name','name','')+field('Owner','owner','')+field('Phone','phone','')+field('Email','email','','email')+'<label>Banner image<input name="image" type="file" accept="image/jpeg,image/png,image/webp"></label>'+'<label>Status<select name="status">'+options(['active','ordered','taken_down'],'ordered')+'</select></label><label>Notes<textarea name="notes"></textarea></label><p data-image-feedback role="status"></p><button>Create banner</button></form>':'')+
 '<p class="sponsor-directory-count">'+filtered.length+' banners · '+year+'</p><p data-directory-result role="status"></p><div class="sponsor-existing-artwork-list">'+filtered.map(b=>{
 const p=payments.find(p=>p.banner_id===b.id&&p.year===year)||{},raw=b.source_data?.row||{},legacyPaid=raw.Paid||'',legacyDate=raw['Date Paid']||'';
 return '<article class="sponsor-existing-artwork-card">'+(b.artwork_url?'<img loading="lazy" src="'+esc(b.artwork_url)+'" alt="'+esc(b.name)+' banner">':'')+'<header><h4>'+esc(b.name)+'</h4><span>'+labels[b.status]+'</span></header><p>'+esc(b.owner||'No owner recorded')+'</p><strong>'+year+' · '+labels[p.payment_status||'unknown']+'</strong>'+
 '<details><summary>Contacts and banner</summary><form data-directory-profile="'+b.id+'" class="sponsor-directory-form">'+field('Banner name','name',b.name)+field('Owner','owner',b.owner)+field('Phone','phone',b.phone)+field('Email','email',b.email,'email')+
 '<label>Status<select name="status">'+options(['active','ordered','taken_down'],b.status)+'</select></label>'+field('Banner image URL','artwork_url',b.artwork_url)+'<label>Notes<textarea name="notes">'+esc(b.notes)+'</textarea></label><button>Save banner</button></form></details><details><summary>Banner image</summary><form data-directory-artwork="'+b.id+'" class="sponsor-directory-form"><label>Choose banner image<input name="image" type="file" accept="image/jpeg,image/png,image/webp" required></label><p data-image-feedback role="status"></p><button>Upload image</button></form></details>'+
 '<details><summary>'+year+' payment</summary><form data-directory-payment-form="'+b.id+'" class="sponsor-directory-form"><label>Payment status<select name="payment_status">'+options(['unknown','unpaid','paid','complimentary'],p.payment_status||'unknown')+'</select></label>'+
 field('Amount paid ($)','amount',p.amount_cents==null?'':(p.amount_cents/100).toFixed(2),'number')+field('Date paid','paid_date',p.paid_date,'date')+field('Expires','expiration_date',p.expiration_date,'date')+field('Payment method','payment_method',p.payment_method)+field('Invoice reference','invoice_id',p.invoice_id)+field('Payment reference','payment_id',p.payment_id)+'<label>Payment notes<textarea name="notes">'+esc(p.notes)+'</textarea></label><button>Save '+year+' payment</button></form></details>'+
 '<details><summary>Payment history</summary>'+payments.filter(x=>x.banner_id===b.id).map(x=>'<p><strong>'+x.year+' · '+labels[x.payment_status]+'</strong> '+(x.amount_cents==null?'':'$'+(x.amount_cents/100).toFixed(2))+' '+esc(x.paid_date||'')+'<br>'+esc(x.payment_method)+' '+esc(x.invoice_id)+'<br>'+esc(x.notes)+'</p>').join('')+
 (Object.keys(raw).length?'<p><strong>Original Drive record</strong><br>Paid: '+esc(legacyPaid||'Not recorded')+' · Date: '+esc(legacyDate||'Not recorded')+'<br>Method: '+esc(raw['Payment Type']||'Not recorded')+'<br>Invoice: '+esc(raw['Invoice Number']||'Not recorded')+'</p>':'')+
 (b.source_data?.receipts||[]).map(r=>'<p>Original receipt · Paid: '+esc(r[1]||'Not recorded')+' · Expires: '+esc(r[2]||'Not recorded')+'</p>').join('')+
 (data.history||[]).filter(h=>h.banner_id===b.id).map(h=>'<p>Previous '+h.year+' entry · '+labels[h.record.payment_status]+' · '+esc(h.record.paid_date||'')+' · updated '+esc(h.changed_at.slice(0,10))+'</p>').join('')+'</details></article>';
 }).join('')+'</div>';
 }
 async function prepareImage(file, deps={}){
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Choose a JPG, PNG or WebP image.');
  if(file.size>50000000)throw new Error('Choose an image smaller than 50 MB.');
  const decode=deps.decode||(async f=>{if(typeof createImageBitmap==='function')return createImageBitmap(f);return new Promise((resolve,reject)=>{const img=new Image(),url=URL.createObjectURL(f);img.onload=()=>{URL.revokeObjectURL(url);resolve(img)};img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('This image could not be opened.'))};img.src=url;})});
  const image=await decode(file);
  try{
   let blob=file;
   if(image.width>3200||image.height>3200||file.size>1900000){
    const canvas=deps.createCanvas?deps.createCanvas():document.createElement('canvas');
    let scale=Math.min(1,3200/Math.max(image.width,image.height));
    for(let attempt=0;attempt<7;attempt++){
     canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));
     const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Could not resize this image.');
     ctx.drawImage(image,0,0,canvas.width,canvas.height);
     blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',Math.max(.65,.9-attempt*.05)));
     if(!blob)throw new Error('Could not prepare this image.');
     if(blob.size<=1900000)break;scale*=.8;
    }
   }
   if(blob.size>2000000)throw new Error('Could not make this image small enough to upload.');
   const encode=deps.toBase64||(b=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('Could not read this image.'));reader.readAsDataURL(b)}));
   return {content_type:blob.type,base64:await encode(blob)};
  }finally{image.close?.();}
 }
 async function mount(host,token){
 if(!host||!token)return;
 let data,state={year:new Date().getFullYear(),status:'active',payment:'all',search:'',newBanner:false};
 async function request(body){
 const r=await fetch('/api/sponsor-catalog',{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store'});
 const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error||'Could not load sponsors.');return d;
 }
 function draw(){if(!host.isConnected)return;host.innerHTML=render(data,state);host.querySelectorAll('input[name="amount"]').forEach(x=>{x.step='0.01';x.min='0'});}
 async function load(){data=await request();draw();}
 host.innerHTML='<p>Loading sponsor directory…</p>';
 host.addEventListener('change',e=>{const t=e.target;if(t.matches('input[name="image"]')){t.form.querySelector('[data-image-feedback]').textContent=t.files?.[0]?t.files[0].name+' selected. Large images are resized automatically.':'';return;}if(t.matches('[data-directory-year]'))state.year=Number(t.value);else if(t.matches('[data-directory-status]'))state.status=t.value;else if(t.matches('[data-directory-payment]'))state.payment=t.value;else return;draw();});
 host.addEventListener('input',e=>{if(!e.target.matches('[data-directory-search]'))return;state.search=e.target.value;const pos=e.target.selectionStart;draw();const input=host.querySelector('[data-directory-search]');input.focus();input.setSelectionRange(pos,pos);});
 host.addEventListener('click',e=>{if(e.target.closest('[data-new-banner]')){state.newBanner=!state.newBanner;draw();}});
 host.addEventListener('submit',async e=>{
 const form=e.target;if(!form.matches('[data-directory-profile],[data-directory-payment-form],[data-directory-create],[data-directory-artwork]'))return;e.preventDefault();
 const b=Object.fromEntries(new FormData(form)),file=b.image;delete b.image;
 const hasImage=Boolean(file?.size);
 const feedback=form.querySelector('[data-image-feedback]')||host.querySelector('[data-directory-result]');
 if(form.hasAttribute('data-directory-artwork')&&!hasImage){feedback.textContent='Choose an image first.';return;}
 b.action=form.hasAttribute('data-directory-artwork')?'artwork':form.hasAttribute('data-directory-create')?'create':form.hasAttribute('data-directory-profile')?'profile':'payment';
 b.id=form.dataset.directoryProfile||form.dataset.directoryPaymentForm||form.dataset.directoryArtwork;
 if(b.action==='payment'){b.year=state.year;b.amount_cents=b.amount===''?null:Math.round(Number(b.amount)*100);delete b.amount;}
 const btn=form.querySelector('button');btn.disabled=true;let created=null;
 try{
  if(hasImage)feedback.textContent='Preparing image…';
  const image=hasImage?await prepareImage(file):null;
  if(hasImage)feedback.textContent='Uploading image…';
  if(b.action==='artwork')await request({...b,...image});
  else {const saved=await request(b);if(b.action==='create'){created=saved.banner;if(image)await request({action:'artwork',id:created.id,...image});}}
  state.newBanner=false;await load();host.querySelector('[data-directory-result]').textContent=hasImage?'Banner image saved.':'Saved.';
  if(b.action==='artwork'){const savedForm=host.querySelector('[data-directory-artwork="'+b.id+'"]');if(savedForm){savedForm.closest('details').open=true;savedForm.querySelector('[data-image-feedback]').textContent='Banner image saved.';}}
 }catch(err){
  if(created){state.newBanner=false;await load();host.querySelector('[data-directory-result]').textContent='Banner created, but the image could not upload. Use Banner image to try again. '+err.message;}
  else {feedback.textContent=err.message;btn.disabled=false;}
 }
 });
 try{await load();}catch(err){host.innerHTML='<p role="alert">'+esc(err.message)+'</p><button data-directory-retry>Retry</button>';host.querySelector('[data-directory-retry]').onclick=()=>mount(host,token);}
 }
 root.RORC_SPONSORS={mount,render,prepareImage};
 if(typeof module==='object')module.exports={render,prepareImage};
})(typeof window==='object'?window:globalThis);

