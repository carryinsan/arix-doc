/* ArixDoc local document engine. Documents never leave this browser tab. */
const CDN = 'https://cdn.jsdelivr.net/npm';
const VERSIONS = Object.freeze({
  pdfjs: '6.4.299',
  jszip: '3.10.2',
  paddle: '0.4.2',
  tesseract: '7.0.0',
  pdfLib: '1.17.1'
});

let pdfPromise;
let zipPromise;
let paddlePromise;
let paddleInstance;
let paddleInstanceLang = '';
const paddleFailures = new Set();
const tesseractWorkers = new Map();

const LANGS = Object.freeze({
  eng: { label: 'English', paddle: 'en', tess: 'eng' },
  hin: { label: 'Hindi', tess: 'hin' },
  guj: { label: 'Gujarati', tess: 'guj' },
  ben: { label: 'Bengali', tess: 'ben' },
  mar: { label: 'Marathi', tess: 'mar' },
  tam: { label: 'Tamil', tess: 'tam' },
  tel: { label: 'Telugu', tess: 'tel' },
  ara: { label: 'Arabic', tess: 'ara' },
  fra: { label: 'French', paddle: 'fr', tess: 'fra' },
  deu: { label: 'German', paddle: 'de', tess: 'deu' },
  spa: { label: 'Spanish', paddle: 'es', tess: 'spa' },
  ita: { label: 'Italian', paddle: 'it', tess: 'ita' },
  por: { label: 'Portuguese', paddle: 'pt', tess: 'por' },
  nld: { label: 'Dutch', paddle: 'nl', tess: 'nld' },
  jpn: { label: 'Japanese', paddle: 'japan', tess: 'jpn' },
  chi_sim: { label: 'Chinese (Simplified)', paddle: 'ch', tess: 'chi_sim' }
});

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Processing cancelled.', 'AbortError');
}

function emit(progress, detail) {
  try { progress?.(detail); } catch { /* UI callbacks must not break the engine. */ }
}

async function loadPdfJs() {
  if (!pdfPromise) pdfPromise = import(`${CDN}/pdfjs-dist@${VERSIONS.pdfjs}/build/pdf.min.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${CDN}/pdfjs-dist@${VERSIONS.pdfjs}/build/pdf.worker.min.mjs`;
    return lib;
  }).catch((error) => { pdfPromise = null; throw error; });
  return pdfPromise;
}

async function loadZip() {
  if (!zipPromise) zipPromise = import(`${CDN}/jszip@${VERSIONS.jszip}/+esm`).then((m) => m.default || m).catch((error) => {
    zipPromise = null;
    throw error;
  });
  return zipPromise;
}

async function loadPaddle() {
  if (!paddlePromise) paddlePromise = import(`${CDN}/@paddleocr/paddleocr-js@${VERSIONS.paddle}/+esm`).then((m) => m.PaddleOCR).catch((error) => {
    paddlePromise = null;
    throw error;
  });
  return paddlePromise;
}

async function getTesseractWorker(lang, progress) {
  const language = LANGS[lang]?.tess || 'eng';
  if (!tesseractWorkers.has(language)) {
    const pending = import(`${CDN}/tesseract.js@${VERSIONS.tesseract}/+esm`).then(async ({ createWorker }) => {
      const worker = await createWorker(language, 1, {
        logger: (m) => {
          if (m?.status === 'loading language traineddata' || m?.status === 'initializing api') {
            emit(progress, { phase: 'model', message: m.status, modelProgress: m.progress ?? null });
          }
        }
      });
      return worker;
    }).catch((error) => {
      tesseractWorkers.delete(language);
      throw error;
    });
    tesseractWorkers.set(language, pending);
  }
  return tesseractWorkers.get(language);
}

function makeCanvas(source, maxSide = 3000) {
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  if (!width || !height) throw new Error('The image could not be decoded.');
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function enhanceCanvas(canvas, enabled) {
  if (!enabled) return canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  // Conservative grayscale/contrast normalization; avoids aggressive thresholding
  // that can erase thin strokes, diacritics, or colored annotations.
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    if (gray < min) min = gray;
    if (gray > max) max = gray;
    data[i] = data[i + 1] = data[i + 2] = gray;
  }
  const span = Math.max(48, max - min);
  const gain = 230 / span;
  for (let i = 0; i < data.length; i += 4) {
    const value = Math.max(0, Math.min(255, (data[i] - min) * gain + 12));
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function polygonBounds(poly) {
  if (!Array.isArray(poly) || !poly.length) return null;
  const xs = poly.map((p) => Number(Array.isArray(p) ? p[0] : p.x)).filter(Number.isFinite);
  const ys = poly.map((p) => Number(Array.isArray(p) ? p[1] : p.y)).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y) };
}

function paddleBlocks(items) {
  return (items || []).map((item) => ({
    type: 'text', text: String(item.text || ''), bbox: polygonBounds(item.poly),
    confidence: Number.isFinite(item.score) ? item.score : null, source: 'ocr', polygon: item.poly || null
  })).filter((b) => b.text.trim());
}

function tesseractBlocks(data) {
  const lines = Array.isArray(data?.lines) ? data.lines : [];
  if (lines.length) return lines.map((line) => ({
    type: 'text', text: String(line.text || '').trim(),
    bbox: line.bbox ? { x: line.bbox.x0, y: line.bbox.y0, width: line.bbox.x1 - line.bbox.x0, height: line.bbox.y1 - line.bbox.y0 } : null,
    confidence: Number.isFinite(line.confidence) ? line.confidence / 100 : null, source: 'ocr'
  })).filter((b) => b.text);
  return (data?.words || []).map((word) => ({
    type: 'text', text: String(word.text || '').trim(),
    bbox: word.bbox ? { x: word.bbox.x0, y: word.bbox.y0, width: word.bbox.x1 - word.bbox.x0, height: word.bbox.y1 - word.bbox.y0 } : null,
    confidence: Number.isFinite(word.confidence) ? word.confidence / 100 : null, source: 'ocr'
  })).filter((b) => b.text);
}

async function recognizeCanvas(canvas, options, signal, progress) {
  checkAbort(signal);
  const lang = options.lang || 'eng';
  const language = LANGS[lang] || LANGS.eng;
  const mode = options.engine || 'auto';
  const canUsePaddle = Boolean(language.paddle) && mode !== 'tesseract';
  if (mode === 'paddle' && !language.paddle) throw new Error(`PaddleOCR.js has no browser model for ${language.label}; choose Auto or Tesseract.`);
  if (mode === 'paddle' && paddleFailures.has(language.paddle)) throw new Error(`PaddleOCR initialization previously failed for ${language.label}; reload the page or choose Auto/Tesseract.`);
  if (canUsePaddle && !paddleFailures.has(language.paddle)) {
    try {
      emit(progress, { phase: 'ocr', message: 'Initializing local PaddleOCR model…' });
      const PaddleOCR = await loadPaddle();
      if (paddleInstance && paddleInstanceLang !== language.paddle) {
        paddleInstance.dispose?.();
        paddleInstance = null;
      }
      if (!paddleInstance) {
        paddleInstance = await PaddleOCR.create({
          lang: language.paddle,
          ocrVersion: 'PP-OCRv6',
          ortOptions: { backend: 'auto' }
        });
        paddleInstanceLang = language.paddle;
      }
      checkAbort(signal);
      const [result] = await paddleInstance.predict(canvas, { textRecScoreThresh: 0.0 });
      const blocks = paddleBlocks(result?.items);
      if (blocks.length) return { blocks, engine: 'PaddleOCR.js', metrics: result?.metrics || null };
    } catch (error) {
      paddleFailures.add(language.paddle);
      if (mode === 'paddle') throw new Error(`PaddleOCR could not initialize: ${error.message}`);
      emit(progress, { phase: 'fallback', message: 'PaddleOCR unavailable; switching to Tesseract.js locally.' });
    }
  }
  checkAbort(signal);
  emit(progress, { phase: 'ocr', message: `Recognizing locally with Tesseract (${language.tess || 'eng'})…` });
  const worker = await getTesseractWorker(lang, progress);
  const { data } = await worker.recognize(canvas);
  checkAbort(signal);
  return { blocks: tesseractBlocks(data), engine: 'Tesseract.js', metrics: null };
}

function meaningfulPdfText(items) {
  const text = items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
  const chars = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  return { text, meaningful: chars >= 18 && text.split(/\s+/).length >= 4 };
}

async function processPdf(file, options, signal, progress) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  checkAbort(signal);

  // Keep the loading task as the authoritative PDF.js lifecycle handle.
  // Its destroy() method terminates the worker and is available even when
  // document parsing/rendering fails part-way through the file.
  const loading = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  let pdf;
  try {
    pdf = await loading.promise;
    const pages = [];
    let nativePages = 0;
    let ocrPages = 0;
    const total = pdf.numPages;

    for (let pageNo = 1; pageNo <= total; pageNo += 1) {
      checkAbort(signal);
      const page = await pdf.getPage(pageNo);
      try {
        const textContent = await page.getTextContent({ includeMarkedContent: false });
        const extracted = meaningfulPdfText(textContent.items || []);
        let blocks = [];
        let source = 'native';
        let engineName = null;
        let imageSize = null;

        if (extracted.meaningful) {
          blocks = (textContent.items || []).filter((item) => item.str?.trim()).map((item) => ({
            type: 'text', text: item.str, bbox: {
              x: Number(item.transform?.[4] || 0), y: Number(item.transform?.[5] || 0),
              width: Number(item.width || 0), height: Number(item.height || 0)
            }, confidence: null, source: 'native'
          }));
          nativePages += 1;
        } else {
          source = 'ocr';
          const viewport = page.getViewport({ scale: Math.min(2.2, 3000 / Math.max(page.view[2] - page.view[0], page.view[3] - page.view[1])) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
          if (!context) throw new Error(`Could not allocate a rendering surface for PDF page ${pageNo}.`);
          context.fillStyle = '#fff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: context, viewport }).promise;
          const prepared = enhanceCanvas(canvas, options.enhance !== false);
          imageSize = { width: prepared.width, height: prepared.height };
          const recognized = await recognizeCanvas(prepared, options, signal, progress);
          blocks = recognized.blocks;
          engineName = recognized.engine;
          ocrPages += 1;
          // Release the potentially large page bitmap as soon as OCR finishes.
          canvas.width = 1;
          canvas.height = 1;
        }

        const text = blocks.map((b) => b.text).join('\n').trim();
        pages.push({
          page: pageNo, text, blocks, source, engine: engineName, imageSize,
          rotation: Number(page.rotate || 0),
          pageSize: { width: page.view[2] - page.view[0], height: page.view[3] - page.view[1] }
        });
        emit(progress, { phase: 'pages', page: pageNo, total, nativePages, ocrPages, percent: Math.round(pageNo / total * 100) });
      } finally {
        // A page may fail during extraction/render/OCR; still release its cache.
        try { page.cleanup(); } catch { /* Best-effort page memory cleanup. */ }
      }
    }

    return {
      pages,
      metadata: {
        format: 'PDF', pageCount: total, nativePages, ocrPages,
        method: ocrPages ? 'hybrid-local' : 'native-local'
      }
    };
  } finally {
    // PDFDocumentLoadingTask.destroy() is the documented worker teardown API.
    // Do not call a misspelled/non-existent `pdf.destory` property.
    if (loading && typeof loading.destroy === 'function') {
      try { await loading.destroy(); } catch { /* Preserve the original processing error. */ }
    } else if (pdf && typeof pdf.destroy === 'function') {
      // Compatibility fallback for alternate PDF.js builds.
      try { await pdf.destroy(); } catch { /* Preserve the original processing error. */ }
    }
  }
}

function parseXml(xml, label) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`The ${label} XML is invalid or damaged.`);
  return doc;
}

function localElements(node, name) {
  return Array.from(node.getElementsByTagNameNS('*', name));
}

function cellColumnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, value - 1);
}

function safeEntrySizes(zip) {
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > 20000) throw new Error('Archive contains too many entries (limit: 20,000).');
  let total = 0;
  for (const entry of entries) {
    const size = Number(entry._data?.uncompressedSize || 0);
    const compressed = Number(entry._data?.compressedSize || 0);
    total += size;
    if (size > 200 * 1024 * 1024) throw new Error(`Archive entry is too large: ${entry.name}`);
    if (compressed > 0 && size / compressed > 1000) throw new Error(`Suspicious compression ratio in ${entry.name}.`);
  }
  if (total > 750 * 1024 * 1024) throw new Error('Archive expands beyond the 750 MB safety limit.');
  return entries.length;
}

async function loadOfficeZip(file) {
  if (file.size > 350 * 1024 * 1024) throw new Error('This office document exceeds the 350 MB browser safety limit.');
  const JSZip = await loadZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: false, createFolders: false });
  safeEntrySizes(zip);
  return zip;
}

async function processDocx(file, signal, progress) {
  const zip = await loadOfficeZip(file);
  checkAbort(signal);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('DOCX package is missing word/document.xml.');
  const doc = parseXml(await entry.async('string'), 'DOCX document');
  const paragraphs = localElements(doc, 'p').map((p) => localElements(p, 't').map((t) => t.textContent || '').join('')).filter((s) => s.trim());
  const text = paragraphs.join('\n\n');
  emit(progress, { phase: 'complete', percent: 100 });
  return { pages: [{ page: 1, text, blocks: paragraphs.map((line) => ({ type: 'paragraph', text: line, bbox: null, confidence: null, source: 'native' })), source: 'native' }], tables: [], metadata: { format: 'DOCX', pageCount: 1, nativePages: 1, ocrPages: 0, method: 'native-local' } };
}

async function processXlsx(file, signal, progress) {
  const zip = await loadOfficeZip(file);
  checkAbort(signal);
  const workbookEntry = zip.file('xl/workbook.xml');
  if (!workbookEntry) throw new Error('XLSX package is missing xl/workbook.xml.');
  const workbook = parseXml(await workbookEntry.async('string'), 'XLSX workbook');
  const relEntry = zip.file('xl/_rels/workbook.xml.rels');
  const rels = relEntry ? parseXml(await relEntry.async('string'), 'XLSX relationships') : null;
  const relationMap = new Map((rels ? localElements(rels, 'Relationship') : []).map((node) => [node.getAttribute('Id'), node.getAttribute('Target')]));
  const sharedEntry = zip.file('xl/sharedStrings.xml');
  const sharedStrings = sharedEntry ? localElements(parseXml(await sharedEntry.async('string'), 'XLSX shared strings'), 'si').map((item) => localElements(item, 't').map((t) => t.textContent || '').join('')) : [];
  const sheetNodes = localElements(workbook, 'sheet');
  if (!sheetNodes.length) throw new Error('No worksheets were found in this workbook.');
  const tables = [];
  const pages = [];
  for (let i = 0; i < sheetNodes.length; i += 1) {
    checkAbort(signal);
    const sheetNode = sheetNodes[i];
    const relId = sheetNode.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sheetNode.getAttribute('r:id');
    let target = relationMap.get(relId) || `worksheets/sheet${i + 1}.xml`;
    target = target.replace(/^\//, '').startsWith('xl/') ? target.replace(/^\//, '') : `xl/${target.replace(/^\//, '')}`;
    const sheetEntry = zip.file(target);
    if (!sheetEntry) continue;
    const sheet = parseXml(await sheetEntry.async('string'), 'XLSX worksheet');
    const rows = localElements(sheet, 'row').map((rowNode) => {
      const row = [];
      for (const cell of localElements(rowNode, 'c')) {
        const column = cellColumnIndex(cell.getAttribute('r'));
        const type = cell.getAttribute('t');
        const valueNode = localElements(cell, 'v')[0];
        let value = valueNode?.textContent || '';
        if (type === 's') value = sharedStrings[Number(value)] ?? '';
        else if (type === 'inlineStr') value = localElements(cell, 't').map((t) => t.textContent || '').join('');
        row[column] = value;
      }
      return row;
    }).filter((row) => row.some((cell) => String(cell ?? '').length));
    const name = sheetNode.getAttribute('name') || `Sheet ${i + 1}`;
    tables.push({ name, rows });
    const text = rows.map((row) => row.map((v) => v ?? '').join('\t')).join('\n');
    pages.push({ page: i + 1, text, blocks: [], source: 'native' });
    emit(progress, { phase: 'sheets', page: i + 1, total: sheetNodes.length, percent: Math.round((i + 1) / sheetNodes.length * 100) });
  }
  return { pages, tables, metadata: { format: 'XLSX', pageCount: pages.length, nativePages: pages.length, ocrPages: 0, method: 'native-local' } };
}

async function processPptx(file, signal, progress) {
  const zip = await loadOfficeZip(file);
  checkAbort(signal);
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  if (!slideNames.length) throw new Error('No PowerPoint slides were found.');
  const pages = [];
  for (let i = 0; i < slideNames.length; i += 1) {
    checkAbort(signal);
    const xml = parseXml(await zip.file(slideNames[i]).async('string'), 'PPTX slide');
    const text = localElements(xml, 't').map((n) => n.textContent || '').filter(Boolean).join('\n');
    pages.push({ page: i + 1, text, blocks: text.split('\n').filter(Boolean).map((line) => ({ type: 'text', text: line, bbox: null, confidence: null, source: 'native' })), source: 'native' });
    emit(progress, { phase: 'slides', page: i + 1, total: slideNames.length, percent: Math.round((i + 1) / slideNames.length * 100) });
  }
  return { pages, metadata: { format: 'PPTX', pageCount: pages.length, nativePages: pages.length, ocrPages: 0, method: 'native-local' } };
}

async function processImage(file, options, signal, progress) {
  checkAbort(signal);
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('The image file could not be decoded by this browser.'); }
  try {
    if (bitmap.width * bitmap.height > 120_000_000) throw new Error('Image dimensions exceed the 120-megapixel browser safety limit.');
    const canvas = enhanceCanvas(makeCanvas(bitmap), options.enhance !== false);
    const recognized = await recognizeCanvas(canvas, options, signal, progress);
    const text = recognized.blocks.map((b) => b.text).join('\n').trim();
    return { pages: [{ page: 1, text, blocks: recognized.blocks, source: 'ocr', engine: recognized.engine, imageSize: { width: canvas.width, height: canvas.height } }], metadata: { format: 'IMAGE', pageCount: 1, nativePages: 0, ocrPages: 1, method: 'local-ocr', engine: recognized.engine } };
  } finally { bitmap.close?.(); }
}

function combineResult(file, data, startedAt) {
  const text = (data.pages || []).map((p) => p.text || '').join('\n\n').trim();
  const blocks = (data.pages || []).flatMap((p) => (p.blocks || []).map((b) => ({ ...b, page: p.page })));
  return {
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    processing: { ...data.metadata, elapsedMs: Math.round(performance.now() - startedAt), processedAt: new Date().toISOString() },
    pages: data.pages || [],
    blocks,
    tables: data.tables || [],
    text
  };
}

/**
 * Process a File locally. Optional API credentials only meter a hosted SDK
 * authorization request; all document bytes and OCR inference remain local.
 */
export async function processDocument(file, options = {}) {
  if (!(file instanceof Blob)) throw new TypeError('processDocument expects a browser File or Blob.');
  if (file.size === 0) throw new Error('The selected file is empty.');
  if (file.size > 750 * 1024 * 1024) throw new Error('Files above 750 MB are not accepted by this browser build.');
  const name = String(file.name || 'document').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  const allowed = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'docx', 'xlsx', 'pptx'];
  if (!allowed.includes(ext)) throw new Error(`Unsupported file type: .${ext || 'unknown'}`);
  const startedAt = performance.now();
  const signal = options.signal;
  const progress = options.onProgress;
  if (options.apiKey) {
    const base = String(options.apiBase || '').replace(/\/$/, '');
    if (!base) throw new Error('apiBase is required when apiKey is supplied.');
    const auth = await fetch(`${base}/api/developer`, {
      method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json', 'X-Arix-Key': options.apiKey },
      body: JSON.stringify({ action: 'authorize' }), signal
    });
    const payload = await auth.json().catch(() => ({}));
    if (!auth.ok || !payload.allowed) throw new Error(payload.error || `Developer quota check failed (${auth.status}).`);
  }
  checkAbort(signal);
  emit(progress, { phase: 'inspect', message: `Inspecting ${ext.toUpperCase()} locally…`, percent: 1 });
  let data;
  if (ext === 'pdf') data = await processPdf(file, options, signal, progress);
  else if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) {
    if (file.size > 120 * 1024 * 1024) throw new Error('Image files above 120 MB are not accepted by the browser safety limit.');
    data = await processImage(file, options, signal, progress);
  }
  else if (ext === 'docx') data = await processDocx(file, signal, progress);
  else if (ext === 'xlsx') data = await processXlsx(file, signal, progress);
  else data = await processPptx(file, signal, progress);
  checkAbort(signal);
  const result = combineResult(file, data, startedAt);
  emit(progress, { phase: 'complete', percent: 100, result });
  return result;
}

export async function createSearchablePdf(file, result) {
  if (!String(file?.name || '').toLowerCase().endsWith('.pdf')) throw new Error('Searchable PDF export is available for PDF input only.');
  const { PDFDocument, StandardFonts, rgb } = await import(`${CDN}/pdf-lib@${VERSIONS.pdfLib}/+esm`);
  const pdfDoc = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false, throwOnInvalidObject: false });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  let added = 0;
  for (const pageData of result.pages || []) {
    if (pageData.source !== 'ocr' || !pageData.imageSize) continue;
    if (pageData.rotation && pageData.rotation % 360 !== 0) continue;
    const page = pdfDoc.getPage(pageData.page - 1);
    const pageWidth = page.getWidth();
    const pageHeight = page.getHeight();
    for (const block of pageData.blocks || []) {
      if (!block.text || !block.bbox) continue;
      const text = block.text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
      if (!text.trim()) continue;
      const sx = pageWidth / pageData.imageSize.width;
      const sy = pageHeight / pageData.imageSize.height;
      const fontSize = Math.max(4, Math.min(14, block.bbox.height * sy * 0.85));
      const x = Math.max(0, Math.min(pageWidth - 1, block.bbox.x * sx));
      const y = Math.max(0, Math.min(pageHeight - fontSize, pageHeight - (block.bbox.y + block.bbox.height) * sy));
      try {
        page.drawText(text, { x, y, size: fontSize, font, color: rgb(1, 1, 1), opacity: 0.001, maxWidth: Math.max(fontSize, block.bbox.width * sx), lineHeight: fontSize });
        added += 1;
      } catch { /* Unsupported glyphs or malformed boxes are omitted, never fabricated. */ }
    }
  }
  if (!added) throw new Error('No searchable OCR text could be embedded. This may be a digital PDF or the OCR produced no embeddable Latin-1 text.');
  return new Blob([await pdfDoc.save({ useObjectStreams: true })], { type: 'application/pdf' });
}

function csvEscape(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; // mitigate spreadsheet formula injection in CSV exports
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportCsv(result, tableIndex = 0) {
  if (result.tables?.length) {
    const table = result.tables[tableIndex];
    if (!table) throw new Error('The requested worksheet does not exist.');
    return table.rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  }
  return ['Page,Text', ...(result.pages || []).map((page) => `${page.page},${csvEscape(page.text)}`)].join('\r\n');
}

export async function exportCsvBundle(result) {
  if (!result.tables?.length || result.tables.length === 1) {
    return { blob: new Blob([exportCsv(result)], { type: 'text/csv;charset=utf-8' }), extension: 'csv' };
  }
  const JSZip = await loadZip();
  const safeName = (value) => String(value || 'sheet').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'sheet';
  const zip = new JSZip();
  const seen = new Map();
  for (let i = 0; i < result.tables.length; i += 1) {
    const table = result.tables[i];
    let name = safeName(table.name);
    const count = (seen.get(name) || 0) + 1;
    seen.set(name, count);
    if (count > 1) name += `-${count}`;
    zip.file(`${name}.csv`, exportCsv(result, i));
  }
  return { blob: await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 4 } }), extension: 'csv.zip' };
}

export function getSupportedLanguages() {
  return Object.entries(LANGS).map(([code, item]) => ({ code, label: item.label, engine: item.paddle ? 'PaddleOCR + Tesseract fallback' : 'Tesseract.js' }));
}

export function releaseOcrMemory() {
  for (const pending of tesseractWorkers.values()) pending.then((worker) => worker.terminate()).catch(() => {});
  tesseractWorkers.clear();
  if (paddleInstance?.dispose) paddleInstance.dispose();
  paddleInstance = null;
  paddleInstanceLang = '';
  paddleFailures.clear();
  paddlePromise = null;
}
