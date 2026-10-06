async function scanSSE(source, fn) {
  let buffer = '';
  let event = '';
  let data = '';
  let hasFields = false;

  const flush = () => {
    if (!hasFields) return true;
    const ev = { event, data };
    event = '';
    data = '';
    hasFields = false;
    return fn(ev);
  };

  for await (const chunk of source) {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        hasFields = true;
      } else if (line.startsWith('data:')) {
        if (data) data += '\n';
        data += line.slice(5).replace(/^ /, '');
        hasFields = true;
      } else if (line === '') {
        if (!flush()) return;
      }
    }
  }
  flush();
}

module.exports = { scanSSE };
