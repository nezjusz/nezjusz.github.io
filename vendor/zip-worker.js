importScripts('./jszip-3.10.2.min.js');

let entries, maxTotalBytes;
let totalBytes = 0;

function readEntry(entry, maxEntryBytes) {
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream('uint8array');
    const chunks = [];
    let entryBytes = 0;
    stream.on('data', chunk => {
      entryBytes += chunk.byteLength;
      totalBytes += chunk.byteLength;
      if (entryBytes > maxEntryBytes || totalBytes > maxTotalBytes) {
        stream.pause();
        chunks.length = 0;
        reject(new Error('The unpacked ZIP exceeds the size limit.'));
      } else chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(new Blob(chunks)));
    stream.resume();
  });
}

self.onmessage = async ({ data }) => {
  try {
    let value;
    if (data.file) {
      const zip = await JSZip.loadAsync(await data.file.arrayBuffer());
      entries = Object.values(zip.files);
      if (entries.length > data.limits.maxEntries) throw new Error('The ZIP contains too many entries.');
      maxTotalBytes = data.limits.maxTotalBytes;
      value = entries.map(({ name, dir }, index) => ({ index, name, dir }));
    } else {
      value = await readEntry(entries[data.index], data.maxEntryBytes);
    }
    postMessage({ value });
  } catch (error) {
    postMessage({ error: error.message || 'The ZIP could not be read.' });
  }
};
