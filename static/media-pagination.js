// Real DOM measurements, isolated from the main script pagination classes.
// Range cloning keeps the source runs, including a cut inside one colored span.
export function paginateCaptions(source, host, width, height) {
  const measure=document.createElement('div');measure.className='wb-media-pagination-measure';measure.style.width=width+'px';host.append(measure);
  const pages=[];let page;
  const createPage=()=>{page=document.createElement('section');page.className='wb-media-caption-page';page.style.height=height+'px';page.dataset.captionPageIndex=String(pages.length);measure.append(page);pages.push(page);};
  const fits=(item,keep=false)=>{page.append(item);const fit=page.scrollHeight<=height+1;if(!fit||!keep)item.remove();return fit;};
  const boundaries=value=>{if(typeof Intl.Segmenter==='function')return[0,...Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value),part=>part.index+part.segment.length)];const result=[0];for(const character of value)result.push(result.at(-1)+character.length);return result;};
  const slice=(target,start,end)=>{
    const walker=document.createTreeWalker(target,NodeFilter.SHOW_TEXT),texts=[];let text,offset=0;
    while((text=walker.nextNode())){texts.push({node:text,start:offset,end:offset+text.textContent.length});offset+=text.textContent.length;}
    const first=texts.find(item=>start<item.end)||texts.at(-1),last=texts.find(item=>end<=item.end)||texts.at(-1),range=document.createRange();
    range.setStart(first.node,Math.max(0,start-first.start));range.setEnd(last.node,Math.max(0,end-last.start));
    let fragment=range.cloneContents(),ancestor=range.commonAncestorContainer;if(ancestor.nodeType===Node.TEXT_NODE)ancestor=ancestor.parentNode;
    while(ancestor&&ancestor!==target){const wrapper=ancestor.cloneNode(false);wrapper.append(fragment);const outer=document.createDocumentFragment();outer.append(wrapper);fragment=outer;ancestor=ancestor.parentNode;}
    return fragment;
  };
  try{
    createPage();
    for(const sourceBlock of source.children){
      if(sourceBlock.matches('figure')){
        const imageBlock=sourceBlock.cloneNode(true),image=imageBlock.querySelector('img');imageBlock.style.margin='0';
        if(image){image.style.maxHeight=Math.max(1,height-2)+'px';image.style.maxWidth='100%';image.style.width='auto';image.style.height='auto';}
        if(!fits(imageBlock,true)){if(page.childNodes.length)createPage();if(!fits(imageBlock,true))throw Error('插图无法放入当前台词页');}
        continue;
      }
      const target=sourceBlock.querySelector('.wb-media-block-text')||sourceBlock,value=target.textContent||'';
      const fragment=(start,end)=>{const copy=sourceBlock.cloneNode(true);if(start!==0||end!==value.length)(copy.querySelector('.wb-media-block-text')||copy).replaceChildren(slice(target,start,end));copy.dataset.sourceStart=String(start);copy.dataset.sourceEnd=String(end);return copy;};
      if(fits(fragment(0,value.length),true))continue;
      if(!value.length){if(page.childNodes.length)createPage();if(!fits(fragment(0,0),true))throw Error('当前台词页无法容纳段落');continue;}
      const edges=boundaries(value);let startIndex=0;
      while(startIndex<edges.length-1){
        const start=edges[startIndex];if(fits(fragment(start,value.length),true))break;
        let low=startIndex+1,high=edges.length-1,best=startIndex;
        while(low<=high){const mid=Math.floor((low+high)/2);if(fits(fragment(start,edges[mid]))){best=mid;low=mid+1;}else high=mid-1;}
        if(best===startIndex){if(page.childNodes.length){createPage();continue;}throw Error('当前字号或留白无法容纳一行台词');}
        fits(fragment(start,edges[best]),true);startIndex=best;if(startIndex<edges.length-1)createPage();
      }
    }
    for(const result of pages)result.remove();return pages;
  }finally{measure.remove();}
}
