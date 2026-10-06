// Completed orders join the shared directory; design attachments stay private.
async function linkCompletedSponsor(row, rest, write, invoice = null) {
 if(row.status!=="complete")return;
 let banners=await rest("sponsor_banners?select=id,source_key&source_key=eq."+encodeURIComponent("submission:"+row.id)+"&limit=1");
 if(!banners.length){
  const matches=await rest("sponsor_banners?select=id,name&limit=1000");
  const match=matches.find(b=>b.name.trim().toLowerCase()===row.business_name.trim().toLowerCase());
  if(match)banners=[match];
 }
 if(!banners.length)banners=await write("sponsor_banners","POST",{
  source_key:"submission:"+row.id,name:row.business_name,status:"active",owner:row.contact_name||"",
  phone:row.phone_number||"",email:row.email_address||"",notes:row.design_requests||"",
  source_data:{submission_id:row.id},artwork_url:""
 });
 const banner=banners[0];
 if(row.stripe_invoice_id && !invoice && process.env.STRIPE_SECRET_KEY){
  const stripe=require("stripe")(process.env.STRIPE_SECRET_KEY,{apiVersion:"2026-02-25.clover"});
  invoice=await stripe.invoices.retrieve(row.stripe_invoice_id);
 }
 if(invoice?.status==="paid" && invoice.status_transitions?.paid_at){
  const date=new Date(invoice.status_transitions.paid_at*1000).toISOString().slice(0,10);
  const year=Number(date.slice(0,4));
  const previous=await rest("sponsor_banner_years?select=year&banner_id=eq."+banner.id+"&year=eq."+year+"&limit=1");
  if(!previous.length)await write("sponsor_banner_years","POST",{
   banner_id:banner.id,year,payment_status:"paid",paid_date:date,amount_cents:invoice.amount_paid,
   invoice_id:invoice.id,payment_method:"Stripe",notes:"Payment verified against Stripe invoice."
  });
 }
}
module.exports={linkCompletedSponsor};
