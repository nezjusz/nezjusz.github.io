(() => {
  const workerUrl = new URL('./zip-worker.js', document.currentScript.src);
  globalThis.openBoundedZip = async function (file, limits) {
    if (file.size > limits.maxInputBytes) throw new Error('The ZIP file is too large.');
    const worker = new Worker(workerUrl);
    let pending;

    function close() {
      worker.terminate();
      if (pending) pending.reject(new Error('ZIP reader closed.'));
      pending = null;
    }
    worker.onmessage = ({ data }) => {
      const request = pending;
      if (!request) return;
      pending = null;
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.value);
    };
    worker.onerror = ({ message }) => {
      if (pending) pending.reject(new Error(message || 'ZIP worker could not start.'));
      pending = null;
      close();
    };

    function request(message) {
      return new Promise((resolve, reject) => {
        if (pending) throw new Error('Read one ZIP entry at a time.');
        pending = { resolve, reject };
        worker.postMessage(message);
      });
    }

    try {
      const entries = await request({ file, limits });
      return {
        entries,
        read: (entry, maxEntryBytes) => request({ index: entry.index, maxEntryBytes }),
        close,
      };
    } catch (error) {
      close();
      throw error;
    }
  };
})();
