function readVideoDuration(file) {
  const video = document.createElement('video');
  const url = URL.createObjectURL(file);
  video.preload = 'metadata';
  return new Promise((resolve, reject) => {
    function finish(duration) {
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      if (Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error('The video is unreadable or has no finite duration.'));
    }
    const timer = setTimeout(finish, 15000);
    video.onloadedmetadata = () => finish(video.duration);
    video.onerror = () => finish();
    video.src = url;
  });
}

function releaseDownload(link) {
  if (link.getAttribute('href')?.startsWith('blob:')) URL.revokeObjectURL(link.href);
  link.removeAttribute('href');
}

function removeWorkingFiles(ffmpeg, ...names) {
  for (const name of names) {
    try { ffmpeg.FS('unlink', name); } catch {}
  }
}
