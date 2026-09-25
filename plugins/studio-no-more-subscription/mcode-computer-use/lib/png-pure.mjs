// png-pure.mjs
//
// Minimal PNG encoder and decoder for RGBA8 (color type 6, bit depth 8).
// Pure JavaScript; only uses node:zlib for inflate/deflate. No external
// dependencies — this keeps the plugin free of native binaries per the
// security model.

import { deflateSync, inflateSync, constants } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

// CRC-32 (PNG variant). Precomputed table.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export const Png = {
  // Decode a PNG byte buffer (RGBA8) to { width, height, data } where
  // data is a Buffer of length width*height*4 in RGBA byte order.
  decode(pngBytes) {
    if (!Buffer.isBuffer(pngBytes)) pngBytes = Buffer.from(pngBytes);
    if (pngBytes.length < 8 || !pngBytes.slice(0, 8).equals(PNG_SIG)) {
      throw new Error('PNG: bad signature');
    }
    let p = 8;
    let width = 0, height = 0, colorType = 0, bitDepth = 0;
    const idatChunks = [];
    while (p < pngBytes.length) {
      const len = pngBytes.readUInt32BE(p); p += 4;
      const type = pngBytes.slice(p, p + 4).toString('ascii'); p += 4;
      const data = pngBytes.slice(p, p + len); p += len;
      p += 4; // CRC
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        // compression = data[10]; filter = data[11]; interlace = data[12];
      } else if (type === 'IDAT') {
        idatChunks.push(data);
      } else if (type === 'IEND') {
        break;
      }
    }
    if (bitDepth !== 8) {
      throw new Error(`PNG: only 8-bit channels supported (got bitDepth=${bitDepth})`);
    }
    // Color types: 0=Gray, 2=RGB, 3=Palette, 4=GrayAlpha, 6=RGBA
    // We expand everything to RGBA for downstream code.
    let channels;
    if (colorType === 0)      channels = 1; // Gray
    else if (colorType === 2) channels = 3; // RGB
    else if (colorType === 4) channels = 2; // Gray+Alpha
    else if (colorType === 6) channels = 4; // RGBA
    else {
      throw new Error(`PNG: unsupported color type ${colorType}`);
    }
    const inflated = inflateSync(Buffer.concat(idatChunks));

    // Reverse PNG filter for each scanline, then expand to RGBA.
    const stride = width * channels;
    const outRgba = Buffer.alloc(width * height * 4);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y += 1) {
      const filter = inflated[y * (stride + 1)];
      const row = inflated.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
      const dst = Buffer.alloc(stride);
      for (let x = 0; x < stride; x += 1) {
        const cur = row[x];
        const left = x >= channels ? dst[x - channels] : 0;
        const up = prev[x];
        const upLeft = x >= channels ? prev[x - channels] : 0;
        let val;
        switch (filter) {
          case 0: val = cur; break;
          case 1: val = (cur + left) & 0xFF; break;
          case 2: val = (cur + up) & 0xFF; break;
          case 3: val = (cur + ((left + up) >> 1)) & 0xFF; break;
          case 4: { // Paeth
            const p_ = left + up - upLeft;
            const pa = Math.abs(p_ - left);
            const pb = Math.abs(p_ - up);
            const pc = Math.abs(p_ - upLeft);
            let pred;
            if (pa <= pb && pa <= pc) pred = left;
            else if (pb <= pc) pred = up;
            else pred = upLeft;
            val = (cur + pred) & 0xFF;
            break;
          }
          default:
            throw new Error(`PNG: unsupported filter ${filter}`);
        }
        dst[x] = val;
      }
      // Expand to RGBA.
      const rowStart = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        const si = x * channels;
        const di = rowStart + x * 4;
        if (channels === 1) { // Gray: replicate to RGB, alpha=255
          outRgba[di] = dst[si];
          outRgba[di + 1] = dst[si];
          outRgba[di + 2] = dst[si];
          outRgba[di + 3] = 255;
        } else if (channels === 2) { // Gray+Alpha
          outRgba[di] = dst[si];
          outRgba[di + 1] = dst[si];
          outRgba[di + 2] = dst[si];
          outRgba[di + 3] = dst[si + 1];
        } else if (channels === 3) { // RGB
          outRgba[di] = dst[si];
          outRgba[di + 1] = dst[si + 1];
          outRgba[di + 2] = dst[si + 2];
          outRgba[di + 3] = 255;
        } else { // RGBA
          outRgba[di] = dst[si];
          outRgba[di + 1] = dst[si + 1];
          outRgba[di + 2] = dst[si + 2];
          outRgba[di + 3] = dst[si + 3];
        }
      }
      prev = dst;
    }
    return { width, height, data: outRgba };
  },

  // Encode { width, height, data: RGBA } to a PNG byte buffer.
  // Uses filter 0 (None) on every scanline for simplicity.
  encode({ width, height, data }) {
    if (!Number.isInteger(width) || width <= 0) throw new Error('PNG: bad width');
    if (!Number.isInteger(height) || height <= 0) throw new Error('PNG: bad height');
    if (!Buffer.isBuffer(data)) data = Buffer.from(data);
    if (data.length !== width * height * 4) {
      throw new Error(`PNG: data length ${data.length} != ${width * height * 4}`);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // color type: RGBA
    ihdr[10] = 0;  // compression: deflate
    ihdr[11] = 0;  // filter: adaptive (we use 0 = None per row)
    ihdr[12] = 0;  // interlace: none

    const stride = width * 4;
    const raw = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y += 1) {
      raw[y * (stride + 1)] = 0; // filter 0
      data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
    }
    const compressed = deflateSync(raw, { level: constants.Z_DEFAULT_COMPRESSION });

    return Buffer.concat([
      PNG_SIG,
      chunk('IHDR', ihdr),
      chunk('IDAT', compressed),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  },
};
