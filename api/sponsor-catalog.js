const { billingAddress } = require("./_sponsor-address");
const URL_BASE=(process.env.SUPABASE_URL||"https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/,"");
const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const statuses=new Set(["active","ordered","taken_down"]);
const payments=new Set(["unknown","unpaid","paid","complimentary"]);
async function rest(path,method="GET",body){
 const r=await fetch(URL_BASE+"/rest/v1/"+path,{method,headers:{apikey:KEY,Authorization:"Bearer "+KEY,"Content-Type":"application/json",Prefer:"return=representation"},...(body?{body:JSON.stringify(body)}:{})});
 if(!r.ok) throw Object.assign(new Error("Could not update sponsor records."),{status:500});
 return r.status===204?[]:r.json();
}
async function all(path){let rows=[],offset=0;for(;;){const page=await rest(path+"&limit=1000&offset="+offset);rows.push(...page);if(page.length<1000)return rows;offset+=1000;}}
const clean=(v,max=2000)=>String(v??"").trim().slice(0,max);
function artwork(value){
 const s=clean(value,2000);
 if(!s)return "";
 if(s.startsWith("/")&&!s.startsWith("//"))return s;
 let u;try{u=new URL(s)}catch{throw Object.assign(new Error("Use a valid banner image URL."),{status:400})}
 if(u.protocol!=="https:")throw Object.assign(new Error("Banner images must use HTTPS."),{status:400});
 return u.href;
}
function profile(b){
 const status=clean(b.status)||"active";if(!statuses.has(status))throw Object.assign(new Error("Invalid banner status."),{status:400});
 const name=clean(b.name,250);if(!name)throw Object.assign(new Error("Banner name is required."),{status:400});
 return {...(b.billing_address !== undefined ? {billing_address:billingAddress(b.billing_address)} : {}),name,status,public_contact:b.public_contact===true,owner:clean(b.owner,250),phone:clean(b.phone,100),email:clean(b.email,320),notes:clean(b.notes,10000),artwork_url:artwork(b.artwork_url),updated_at:new Date().toISOString()};
}
function annual(b){
 const year=Number(b.year);if(!Number.isInteger(year)||year<1900||year>2200)throw Object.assign(new Error("Invalid year."),{status:400});
 if(!payments.has(b.payment_status))throw Object.assign(new Error("Invalid payment status."),{status:400});
 const amount=b.amount_cents==null||b.amount_cents===""?null:Number(b.amount_cents);
 if(amount!==null&&(!Number.isInteger(amount)||amount<0))throw Object.assign(new Error("Invalid payment amount."),{status:400});
 const date=v=>{if(!v)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||new Date(v+"T12:00:00Z").toISOString().slice(0,10)!==v)throw Object.assign(new Error("Invalid date."),{status:400});return v};
 return {banner_id:b.id,year,payment_status:b.payment_status,amount_cents:amount,paid_date:date(b.paid_date),expiration_date:date(b.expiration_date),payment_method:clean(b.payment_method,100),invoice_id:clean(b.invoice_id,250),payment_id:clean(b.payment_id,250),notes:clean(b.notes,10000)};
}
module.exports=async(req,res)=>{
 try{
 if(!KEY)return res.status(500).json({success:false,error:"Sponsor records are unavailable."});
 if(req.method==="GET"&&req.query?.public==="1"){
   const banners=await rest("sponsor_banners?select=id,name,status,artwork_url,owner,phone,email,public_contact&status=in.(active,ordered)&order=name.asc&limit=1000");
   res.setHeader("Cache-Control","public, max-age=60, s-maxage=60");
   return res.status(200).json({success:true,banners:banners.map(b=>({id:b.id,name:b.name,status:b.status,artwork_url:b.artwork_url,owner:b.owner||"",phone:b.public_contact===true?b.phone||"":"",email:b.public_contact===true?b.email||"":""}))});
 }
 const token=String(req.headers.authorization||"").match(/^Bearer\s+(.+)$/i)?.[1];
 if(!token)return res.status(401).json({success:false,error:"Log in to manage sponsors."});
 const auth=await fetch(URL_BASE+"/auth/v1/user",{headers:{apikey:KEY,Authorization:"Bearer "+token}});
 if(!auth.ok)return res.status(401).json({success:false,error:"Log in again."});
 const user=await auth.json();
 const managers=await rest("account_members?select=id&account_type=eq.Account%20Manager&auth_user_id=eq."+encodeURIComponent(user.id)+"&limit=1");
 if(!managers.length)return res.status(403).json({success:false,error:"Only account managers can manage sponsors."});
 res.setHeader("Cache-Control","no-store");
 if(req.method==="GET"){
 const [banners,years,history]=await Promise.all([rest("sponsor_banners?select=*&order=name.asc&limit=1000"),all("sponsor_banner_years?select=*&order=year.desc,banner_id.asc"),all("sponsor_banner_history?select=*&order=id.desc")]);
 return res.status(200).json({success:true,banners,years,history});
 }
 if(req.method!=="POST")return res.status(405).json({success:false,error:"Method not allowed."});
 const b=req.body||{},action=b.action;
 if(action==="create"){const rows=await rest("sponsor_banners","POST",profile(b));return res.status(200).json({success:true,banner:rows[0]});}
 if(!/^[a-f0-9-]{36}$/i.test(b.id||""))return res.status(400).json({success:false,error:"Invalid banner."});
 const exists=await rest("sponsor_banners?select=id&id=eq."+b.id+"&limit=1");
 if(!exists.length)return res.status(404).json({success:false,error:"Banner not found."});
 if(action==="artwork"){
 const mime=b.content_type,types={"image/jpeg":"jpg","image/png":"png","image/webp":"webp"};
 if(!types[mime]||typeof b.base64!=="string"||b.base64.length>2800000)return res.status(400).json({success:false,error:"Upload a JPG, PNG or WebP under 2 MB."});
 const bytes=Buffer.from(b.base64,"base64");
 const valid=mime==="image/jpeg"?bytes[0]===255&&bytes[1]===216:mime==="image/png"?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WEBP";
 if(!valid||bytes.length>2000000)return res.status(400).json({success:false,error:"Invalid banner image."});
 const headers={apikey:KEY,Authorization:"Bearer "+KEY},bucket="sponsor-banner-artwork";
 const check=await fetch(URL_BASE+"/storage/v1/bucket/"+bucket,{headers});
 if(check.status===404||check.status===400){
  const made=await fetch(URL_BASE+"/storage/v1/bucket",{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({id:bucket,name:bucket,public:true,file_size_limit:2000000,allowed_mime_types:Object.keys(types)})});
  if(!made.ok)throw new Error("Could not prepare banner image storage.");
 }else if(!check.ok)throw new Error("Could not access banner image storage.");
 const path=b.id+"/"+require("crypto").randomUUID()+"."+types[mime];
 const upload=await fetch(URL_BASE+"/storage/v1/object/"+bucket+"/"+path,{method:"POST",headers:{...headers,"Content-Type":mime},body:bytes});
 if(!upload.ok)throw new Error("Could not upload banner image.");
 const rows=await rest("sponsor_banners?id=eq."+b.id,"PATCH",{artwork_url:URL_BASE+"/storage/v1/object/public/"+bucket+"/"+path,updated_at:new Date().toISOString()});
 return res.status(200).json({success:true,banner:rows[0]});
 }
 if(action==="profile"){const rows=await rest("sponsor_banners?id=eq."+b.id,"PATCH",profile(b));return res.status(200).json({success:true,banner:rows[0]});}
 if(action==="payment"){
 const data=annual(b);
 const r=await fetch(URL_BASE+"/rest/v1/sponsor_banner_years?on_conflict=banner_id,year",{method:"POST",headers:{apikey:KEY,Authorization:"Bearer "+KEY,"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=representation"},body:JSON.stringify(data)});
 if(!r.ok)throw new Error("Could not save payment record.");
 return res.status(200).json({success:true,year:(await r.json())[0]});
 }
 return res.status(400).json({success:false,error:"Invalid action."});
 }catch(e){return res.status(e.status||500).json({success:false,error:e.message||"Could not load sponsors."});}
};
module.exports.profile=profile;module.exports.annual=annual;

