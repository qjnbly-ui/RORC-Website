(async()=>{
 const host=document.getElementById('sponsorGallery'),status=document.getElementById('sponsorGalleryStatus');
 if(!host)return;
 try{
 const response=await fetch('/api/sponsor-catalog?public=1');const body=await response.json();
 if(!response.ok||!body.success)throw new Error('Gallery unavailable');
 const banners=body.banners||[];
 status.textContent=banners.length+' sponsor banners';
 for(const banner of banners){
 const figure=document.createElement('figure');figure.className='sponsors-figure';
 if(banner.artwork_url){const img=document.createElement('img');img.src=banner.artwork_url;img.alt=banner.name+' banner';img.loading='lazy';img.dataset.owner=banner.owner||'';img.dataset.phone=banner.phone||'';img.dataset.email=banner.email||'';figure.append(img);}
 if(!banner.artwork_url){const caption=document.createElement('figcaption');caption.textContent=banner.name;figure.append(caption);}host.append(figure);
 }
 document.dispatchEvent(new Event('sponsors-loaded'));
 }catch{status.textContent='The sponsor gallery could not load. Please refresh to try again.';}
})();
