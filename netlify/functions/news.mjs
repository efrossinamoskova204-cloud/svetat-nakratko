const feeds = {
  'България': 'https://news.google.com/rss?hl=bg&gl=BG&ceid=BG:bg',
  'Свят': 'https://news.google.com/rss/search?q=%D1%81%D0%B2%D1%8F%D1%82&hl=bg&gl=BG&ceid=BG:bg',
  'Наука': 'https://news.google.com/rss/search?q=%D0%BD%D0%B0%D1%83%D0%BA%D0%B0&hl=bg&gl=BG&ceid=BG:bg',
  'Образование': 'https://news.google.com/rss/search?q=%D0%BE%D0%B1%D1%80%D0%B0%D0%B7%D0%BE%D0%B2%D0%B0%D0%BD%D0%B8%D0%B5&hl=bg&gl=BG&ceid=BG:bg',
  'Технологии': 'https://news.google.com/rss/search?q=%D1%82%D0%B5%D1%85%D0%BD%D0%BE%D0%BB%D0%BE%D0%B3%D0%B8%D0%B8&hl=bg&gl=BG&ceid=BG:bg'
};
export default async (request) => {
  const category = new URL(request.url).searchParams.get('category') || 'България';
  if (!Object.hasOwn(feeds,category)) return new Response('Invalid category',{status:400});
  try {
    const response=await fetch(feeds[category],{headers:{'User-Agent':'Mozilla/5.0 (compatible; NewsReader/1.0)','Accept':'application/rss+xml, application/xml, text/xml'},signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error(`Source HTTP ${response.status}`);
    const xml=await response.text();
    if (!xml.includes('<rss') && !xml.includes('<feed')) throw new Error('Not RSS');
    return new Response(xml,{headers:{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'public, max-age=180, s-maxage=300','Access-Control-Allow-Origin':'*'}});
  } catch(error) {return new Response(JSON.stringify({error:'News source unavailable'}),{status:502,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})}
};
export const config={path:'/api/news'};
