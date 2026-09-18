// Pagination uses the browser's real fonts, line wrapping and image dimensions.
// Text fragments are cloned with DOM Range so inline source colors stay intact.
export function paginate(source, stage, width, height) {
  const measure = document.createElement('div');
  measure.className = 'stage-pagination-measure';
  measure.style.width = width + 'px';
  stage.append(measure);
  const pages = [];
  let page, body;
  const createPage = () => {
    page = document.createElement('section');
    page.className = 'stage-page';
    page.dataset.pageIndex = String(pages.length);
    page.style.display = 'block';
    body = document.createElement('div');
    body.className = 'stage-page-body';
    body.style.height = height + 'px';
    page.append(body); measure.append(page); pages.push(page);
  };
  const attach = (node, isBlock) => {
    let parent = body;
    if (isBlock) {
      parent = body.lastElementChild;
      if (!parent?.classList.contains('stage-body')) {
        parent = document.createElement('article'); parent.className = 'stage-body'; body.append(parent);
      }
    }
    parent.append(node);
    return () => { node.remove(); if (isBlock && !parent.childNodes.length) parent.remove(); };
  };
  const tryNode = (node, isBlock, keep = false) => {
    const undo = attach(node, isBlock);
    const fits = body.scrollHeight <= height + 1;
    if (!fits || !keep) undo();
    return fits;
  };
  const bounds = value => {
    if (typeof Intl.Segmenter === 'function') return [0, ...Array.from(new Intl.Segmenter(undefined, {granularity:'grapheme'}).segment(value), part => part.index + part.segment.length)];
    const result = [0]; for (const char of value) result.push(result[result.length - 1] + char.length); return result;
  };
  const rangeContents = (node, start, end) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const texts = []; let item, offset = 0;
    while ((item = walker.nextNode())) { texts.push({node:item, start:offset, end:offset + item.textContent.length}); offset += item.textContent.length; }
    const first = texts.find(entry => start < entry.end) || texts[texts.length - 1];
    const last = texts.find(entry => end <= entry.end) || texts[texts.length - 1];
    const range = document.createRange();
    range.setStart(first.node, Math.max(0, start - first.start));
    range.setEnd(last.node, Math.max(0, end - last.start));
    let fragment = range.cloneContents();
    // cloneContents omits the common ancestor. A cut contained in one colored
    // span otherwise becomes a bare Text node and loses that run's color.
    let ancestor = range.commonAncestorContainer;
    if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentNode;
    while (ancestor && ancestor !== node) {
      const wrapper = ancestor.cloneNode(false);
      wrapper.append(fragment);
      const outer = document.createDocumentFragment(); outer.append(wrapper);
      fragment = outer; ancestor = ancestor.parentNode;
    }
    return fragment;
  };
  try {
    createPage();
    const units = [];
    for (const child of source.children) {
      if (child.classList.contains('stage-body')) for (const block of child.children) units.push({node:block, isBlock:true});
      else units.push({node:child, isBlock:false});
    }
    for (const {node, isBlock} of units) {
      if (node.matches('figure, .image-block')) {
        const clone = node.cloneNode(true);
        const img = clone.querySelector('img');
        clone.style.margin = '16px 0';
        if (img) { img.style.maxHeight = Math.max(40, height - 92) + 'px'; img.style.maxWidth = '100%'; img.style.width = 'auto'; img.style.height = 'auto'; }
        if (!tryNode(clone, isBlock, true)) {
          if (body.childNodes.length) createPage();
          if (!tryNode(clone, isBlock, true)) throw new Error('图片和图注超过了当前单页可用高度');
        }
        continue;
      }
      const target = isBlock ? node.querySelector('.block-text') || node : node;
      const value = target.textContent || '';
      const fragment = (start, end) => {
        const clone = node.cloneNode(true);
        if (start !== 0 || end !== value.length) {
          const destination = isBlock ? clone.querySelector('.block-text') || clone : clone;
          destination.replaceChildren(rangeContents(target, start, end));
        }
        if (isBlock) { clone.dataset.sourceStart = String(start); clone.dataset.sourceEnd = String(end); }
        return clone;
      };
      if (tryNode(fragment(0, value.length), isBlock, true)) continue;
      if (!value.length) {
        if (body.childNodes.length) createPage();
        if (!tryNode(fragment(0, 0), isBlock, true)) throw new Error('当前字号或留白使段落无法放入单页');
        continue;
      }
      const edges = bounds(value); let startIndex = 0;
      while (startIndex < edges.length - 1) {
        const start = edges[startIndex];
        if (tryNode(fragment(start, value.length), isBlock, true)) break;
        let low = startIndex + 1, high = edges.length - 1, best = startIndex;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          if (tryNode(fragment(start, edges[mid]), isBlock)) { best = mid; low = mid + 1; }
          else high = mid - 1;
        }
        if (best === startIndex) {
          if (body.childNodes.length) { createPage(); continue; }
          throw new Error('当前字号或留白使一行正文无法放入单页');
        }
        tryNode(fragment(start, edges[best]), isBlock, true);
        startIndex = best;
        if (startIndex < edges.length - 1) createPage();
      }
    }
    for (const result of pages) { result.style.removeProperty('display'); result.remove(); }
    return pages;
  } finally { measure.remove(); }
}
