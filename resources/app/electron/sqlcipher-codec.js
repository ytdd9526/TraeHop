
const fs = require('fs');
const crypto = require('crypto');

const PS = 4096;
const CT_END = 4016;
const IV_OFF = CT_END;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');

// SQLCipher 页布局：ct[0:4016] + iv[4016:4032] + hmac[4032:4096]；页1前16字节为明文salt
function decryptDb(src, dst, key) {
  const fin = fs.openSync(src, 'r');
  const fout = fs.openSync(dst, 'w');
  const page = Buffer.alloc(PS);
  const out = Buffer.alloc(PS);
  let n = 0;
  try {
    while (true) {
      const read = fs.readSync(fin, page, 0, PS, null);
      if (read === 0) break;
      if (read !== PS) throw new Error('数据库文件不是完整页（可能损坏）');
      const iv = page.subarray(IV_OFF, IV_OFF + 16);
      const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
      dec.setAutoPadding(false);
      out.fill(0);
      if (n === 0) {
        const body = Buffer.concat([dec.update(page.subarray(16, CT_END)), dec.final()]);
        SQLITE_MAGIC.copy(out, 0);
        body.copy(out, 16, 0, CT_END - 16);
      } else {
        const body = Buffer.concat([dec.update(page.subarray(0, CT_END)), dec.final()]);
        body.copy(out, 0, 0, CT_END);
      }
      fs.writeSync(fout, out, 0, PS, null);
      n += 1;
    }
  } finally {
    fs.closeSync(fin);
    fs.closeSync(fout);
  }
  if (n === 0) throw new Error('解密失败：空数据库');
  return n;
}

function encryptDb(plainPath, outPath, key, salt) {
  const hmacSalt = Buffer.alloc(16);
  for (let i = 0; i < 16; i += 1) hmacSalt[i] = salt[i] ^ 0x3a;
  const hmacKey = crypto.pbkdf2Sync(key, hmacSalt, 2, 32, 'sha512');

  const fin = fs.openSync(plainPath, 'r');
  const fout = fs.openSync(outPath, 'w');
  const page = Buffer.alloc(PS);
  const pgno = Buffer.alloc(4);
  let n = 0;
  try {
    while (true) {
      const read = fs.readSync(fin, page, 0, PS, null);
      if (read === 0) break;
      if (read !== PS) throw new Error('明文库页不完整');
      n += 1;
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      cipher.setAutoPadding(false);
      const head = n === 1 ? salt : null;
      const ct = n === 1
        ? Buffer.concat([cipher.update(page.subarray(16, CT_END)), cipher.final()])
        : Buffer.concat([cipher.update(page.subarray(0, CT_END)), cipher.final()]);
      pgno.writeUInt32LE(n, 0);
      const mac = crypto.createHmac('sha512', hmacKey)
        .update(Buffer.concat([ct, iv, pgno]))
        .digest();
      const body = head ? Buffer.concat([head, ct, iv, mac]) : Buffer.concat([ct, iv, mac]);
      fs.writeSync(fout, body, 0, PS, null);
    }
  } finally {
    fs.closeSync(fin);
    fs.closeSync(fout);
  }
  return n;
}

// WAL 帧校验与合并：帧页是加密页，帧 checksum 建立在密文上（与 sqlcipher codec 顺序一致）
function walApply(plainPath, walPath, key) {
  const data = fs.readFileSync(walPath);
  if (data.length < 32) return { frames: 0, applied: 0, dbsize: 0, skipped: true };

  const magic = data.readUInt32BE(0);
  const ver = data.readUInt32BE(4);
  if ((magic !== 0x377F0682 && magic !== 0x377F0683) || ver !== 3007000) {
    return { frames: 0, applied: 0, dbsize: 0, skipped: true };
  }
  const be = (magic & 1) === 1;
  const psz = data.readUInt32BE(8);
  const hs1 = data.readUInt32BE(16);
  const hs2 = data.readUInt32BE(20);
  const c1 = data.readUInt32BE(24);
  const c2 = data.readUInt32BE(28);

  const ck = (s0, s1, buf) => {
    for (let i = 0; i + 8 <= buf.length; i += 8) {
      const x1 = be ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
      const x2 = be ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
      s0 = (s0 + x1 + s1) >>> 0;
      s1 = (s1 + x2 + s0) >>> 0;
    }
    return [s0, s1];
  };

  const [hc1, hc2] = ck(0, 0, data.subarray(0, 24));
  if (hc1 !== c1 || hc2 !== c2) return { frames: 0, applied: 0, dbsize: 0, skipped: true };

  const frames = [];
  let s0 = c1;
  let s1 = c2;
  const frameSize = 24 + psz;
  const total = Math.floor((data.length - 32) / frameSize);
  let off = 32;
  for (let i = 0; i < total; i += 1) {
    const fs1 = data.readUInt32BE(off + 8);
    const fs2 = data.readUInt32BE(off + 12);
    if (fs1 !== hs1 || fs2 !== hs2) break;
    const fc1 = data.readUInt32BE(off + 16);
    const fc2 = data.readUInt32BE(off + 20);
    const pageData = data.subarray(off + 24, off + 24 + psz);
    let acc = ck(s0, s1, data.subarray(off, off + 8));
    acc = ck(acc[0], acc[1], pageData);
    if (acc[0] !== fc1 || acc[1] !== fc2) break;
    s0 = acc[0];
    s1 = acc[1];
    frames.push({
      pgno: data.readUInt32BE(off),
      commit: data.readUInt32BE(off + 4),
      pageData,
    });
    off += frameSize;
  }

  let last = -1;
  let dbsize = 0;
  frames.forEach((f, i) => {
    if (f.commit) {
      last = i;
      dbsize = f.commit;
    }
  });
  if (last < 0) return { frames: frames.length, applied: 0, dbsize: 0 };

  const fd = fs.openSync(plainPath, 'r+');
  try {
    const out = Buffer.alloc(PS);
    for (let i = 0; i <= last; i += 1) {
      const { pgno, pageData } = frames[i];
      const iv = pageData.subarray(IV_OFF, IV_OFF + 16);
      const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
      dec.setAutoPadding(false);
      out.fill(0);
      if (pgno === 1) {
        const body = Buffer.concat([dec.update(pageData.subarray(16, CT_END)), dec.final()]);
        SQLITE_MAGIC.copy(out, 0);
        body.copy(out, 16, 0, CT_END - 16);
      } else {
        const body = Buffer.concat([dec.update(pageData.subarray(0, CT_END)), dec.final()]);
        body.copy(out, 0, 0, CT_END);
      }
      fs.writeSync(fd, out, 0, PS, (pgno - 1) * PS);
    }
    const target = dbsize * PS;
    const cur = fs.fstatSync(fd).size;
    if (target > cur) fs.writeSync(fd, Buffer.alloc(target - cur), 0, target - cur, cur);
    else if (target < cur) fs.ftruncateSync(fd, target);
  } finally {
    fs.closeSync(fd);
  }
  return { frames: frames.length, applied: last + 1, dbsize };
}

module.exports = { decryptDb, encryptDb, walApply, PS, CT_END };
