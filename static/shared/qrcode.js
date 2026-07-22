/*
 * GARNI アプリ - 軽量QRコード生成ライブラリ（外部ライブラリ・CDN不使用）
 * ISO/IEC 18004 のQRコード仕様に基づく自前実装。バイトモード（UTF-8）専用、
 * バージョン1〜4（21×21〜33×33）に対応。紹介コードURL程度の短い文字列を
 * 表示する用途に十分な容量（誤り訂正レベルMで最大64バイト）を持つ。
 *
 * 使い方:
 *   const { size, modules } = QRCode.generateMatrix("https://example.com/?ref=ABCDEF");
 *   QRCode.renderToCanvas(canvasEl, "https://example.com/?ref=ABCDEF");
 */
(function (global) {
  "use strict";

  // ---------------------------------------------------------------------
  // ガロア体 GF(256) 演算（既約多項式 x^8 + x^4 + x^3 + x^2 + 1 = 0x11D）
  // ---------------------------------------------------------------------
  const GF_EXP = new Array(512);
  const GF_LOG = new Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();
  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function polyMul(a, b) {
    const result = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        result[i + j] ^= gfMul(a[i], b[j]);
      }
    }
    return result;
  }

  function rsGeneratorPoly(degree) {
    let g = [1];
    for (let i = 0; i < degree; i++) {
      g = polyMul(g, [1, GF_EXP[i]]);
    }
    return g;
  }

  function rsEncode(dataCodewords, ecCount) {
    const generator = rsGeneratorPoly(ecCount);
    const msg = dataCodewords.concat(new Array(ecCount).fill(0));
    for (let i = 0; i < dataCodewords.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < generator.length; j++) {
          msg[i + j] ^= gfMul(generator[j], coef);
        }
      }
    }
    return msg.slice(dataCodewords.length);
  }

  // ---------------------------------------------------------------------
  // バージョン別テーブル（1〜4のみ。いずれもブロック分割は均一で group 分割なし）
  // ---------------------------------------------------------------------
  // dataCodewords: 誤り訂正レベルごとの総データ符号語数
  const CAPACITY = {
    1: { L: 19, M: 16, Q: 13, H: 9 },
    2: { L: 34, M: 28, Q: 22, H: 16 },
    3: { L: 55, M: 44, Q: 34, H: 26 },
    4: { L: 80, M: 64, Q: 48, H: 36 },
  };
  // [ecCodewordsPerBlock, numBlocks, dataCodewordsPerBlock]
  const EC_BLOCKS = {
    1: { L: [7, 1, 19], M: [10, 1, 16], Q: [13, 1, 13], H: [17, 1, 9] },
    2: { L: [10, 1, 34], M: [16, 1, 28], Q: [22, 1, 22], H: [28, 1, 16] },
    3: { L: [15, 1, 55], M: [26, 1, 44], Q: [18, 2, 17], H: [22, 2, 13] },
    4: { L: [20, 1, 80], M: [18, 2, 32], Q: [26, 2, 24], H: [16, 4, 9] },
  };
  const TOTAL_CODEWORDS = { 1: 26, 2: 44, 3: 70, 4: 100 };
  // バージョン2〜4はアライメントパターンが1個のみ（座標は (n,n)）
  const ALIGNMENT_CENTER = { 2: 18, 3: 22, 4: 26 };
  const EC_LEVEL_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
  const FORMAT_GENERATOR = 0x537; // BCH(15,5) 生成多項式
  const FORMAT_MASK = 0x5412;

  function utf8Bytes(str) {
    return Array.from(new TextEncoder().encode(str));
  }

  function pushBits(bits, value, length) {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  }

  function chooseVersion(byteLen, ecLevel) {
    for (let v = 1; v <= 4; v++) {
      const cap = CAPACITY[v][ecLevel];
      const headerBits = 4 + 8; // モード指示子(4bit) + バイト数指示子(8bit, v<=9)
      const availBits = cap * 8;
      if (headerBits + byteLen * 8 <= availBits) return v;
    }
    return null; // 収まらない（呼び出し側でエラーにする）
  }

  function buildCodewords(text, version, ecLevel) {
    const bytes = utf8Bytes(text);
    const dataCodewordCount = CAPACITY[version][ecLevel];
    const bits = [];
    pushBits(bits, 0b0100, 4); // バイトモード
    pushBits(bits, bytes.length, 8);
    for (const b of bytes) pushBits(bits, b, 8);
    const maxBits = dataCodewordCount * 8;
    for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      codewords.push(byte);
    }
    const padBytes = [0xec, 0x11];
    let p = 0;
    while (codewords.length < dataCodewordCount) {
      codewords.push(padBytes[p % 2]);
      p++;
    }
    return codewords;
  }

  function interleaveWithEC(dataCodewords, version, ecLevel) {
    const [ecPerBlock, numBlocks, dataPerBlock] = EC_BLOCKS[version][ecLevel];
    const blocks = [];
    for (let i = 0; i < numBlocks; i++) {
      const data = dataCodewords.slice(i * dataPerBlock, (i + 1) * dataPerBlock);
      const ecc = rsEncode(data, ecPerBlock);
      blocks.push({ data, ecc });
    }
    const result = [];
    for (let i = 0; i < dataPerBlock; i++) {
      for (const b of blocks) result.push(b.data[i]);
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (const b of blocks) result.push(b.ecc[i]);
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // 行列（マトリクス）構築
  // ---------------------------------------------------------------------
  function makeMatrix(size) {
    const m = [];
    const reserved = [];
    for (let i = 0; i < size; i++) {
      m.push(new Array(size).fill(0));
      reserved.push(new Array(size).fill(false));
    }
    return { m, reserved };
  }

  function setModule(m, reserved, r, c, val) {
    m[r][c] = val ? 1 : 0;
    reserved[r][c] = true;
  }

  function placeFinder(m, reserved, top, left) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = top + r, cc = left + c;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        const isBorder = r === -1 || r === 7 || c === -1 || c === 7;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const dark = !isBorder && (inRing || inCore);
        setModule(m, reserved, rr, cc, dark);
      }
    }
  }

  function placeAlignment(m, reserved, centerR, centerC) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const ring = Math.max(Math.abs(r), Math.abs(c));
        const dark = ring !== 1;
        setModule(m, reserved, centerR + r, centerC + c, dark);
      }
    }
  }

  function placeTiming(m, reserved, size) {
    for (let i = 8; i < size - 8; i++) {
      const dark = i % 2 === 0;
      if (!reserved[6][i]) setModule(m, reserved, 6, i, dark);
      if (!reserved[i][6]) setModule(m, reserved, i, 6, dark);
    }
  }

  function reserveFormatAreas(m, reserved, size) {
    for (let i = 0; i <= 8; i++) {
      if (!reserved[8][i]) setModule(m, reserved, 8, i, false);
      if (!reserved[i][8]) setModule(m, reserved, i, 8, false);
    }
    for (let i = 0; i < 8; i++) {
      setModule(m, reserved, 8, size - 1 - i, false);
      setModule(m, reserved, size - 1 - i, 8, false);
    }
  }

  function placeDarkModule(m, reserved, version) {
    const row = 4 * version + 9;
    setModule(m, reserved, row, 8, true);
  }

  function dataMask(pattern, r, c) {
    switch (pattern) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function placeData(m, reserved, size, codewords, maskPattern) {
    const bitLen = codewords.length * 8;
    function bitAt(i) {
      const byte = codewords[Math.floor(i / 8)];
      return (byte >> (7 - (i % 8))) & 1;
    }
    let bitIndex = 0;
    let col = size - 1;
    let dir = -1; // -1 = 上へ, 1 = 下へ
    while (col > 0) {
      if (col === 6) col--; // タイミング列はスキップ
      for (let i = 0; i < size; i++) {
        const row = dir === -1 ? size - 1 - i : i;
        for (let dc = 0; dc < 2; dc++) {
          const c = col - dc;
          if (reserved[row][c]) continue;
          const bit = bitIndex < bitLen ? bitAt(bitIndex) : 0;
          bitIndex++;
          const masked = dataMask(maskPattern, row, c) ? bit ^ 1 : bit;
          m[row][c] = masked;
        }
      }
      dir = -dir;
      col -= 2;
    }
  }

  function penaltyScore(m, size) {
    let score = 0;
    // ルール1: 同色が5連続以上（行・列）
    for (let r = 0; r < size; r++) {
      let runColor = -1, runLen = 0;
      for (let c = 0; c < size; c++) {
        if (m[r][c] === runColor) {
          runLen++;
        } else {
          if (runLen >= 5) score += 3 + (runLen - 5);
          runColor = m[r][c];
          runLen = 1;
        }
      }
      if (runLen >= 5) score += 3 + (runLen - 5);
    }
    for (let c = 0; c < size; c++) {
      let runColor = -1, runLen = 0;
      for (let r = 0; r < size; r++) {
        if (m[r][c] === runColor) {
          runLen++;
        } else {
          if (runLen >= 5) score += 3 + (runLen - 5);
          runColor = m[r][c];
          runLen = 1;
        }
      }
      if (runLen >= 5) score += 3 + (runLen - 5);
    }
    // ルール2: 2x2 同色ブロック
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }
    // ルール3: ファインダーに似たパターン 1:1:3:1:1 (前後に4連続の明マス)
    const pattern1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const pattern2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matches(arr, startIdx, getVal) {
      for (let k = 0; k < arr.length; k++) {
        if (getVal(startIdx + k) !== arr[k]) return false;
      }
      return true;
    }
    for (let r = 0; r < size; r++) {
      for (let c = 0; c <= size - 11; c++) {
        const getVal = (i) => m[r][i];
        if (matches(pattern1, c, getVal) || matches(pattern2, c, getVal)) score += 40;
      }
    }
    for (let c = 0; c < size; c++) {
      for (let r = 0; r <= size - 11; r++) {
        const getVal = (i) => m[i][c];
        if (matches(pattern1, r, getVal) || matches(pattern2, r, getVal)) score += 40;
      }
    }
    // ルール4: 暗モジュールの割合が50%から離れているほど加点
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    const percent = (dark * 100) / (size * size);
    const prevMultiple = Math.floor(percent / 5) * 5;
    const nextMultiple = prevMultiple + 5;
    score += Math.min(Math.abs(prevMultiple - 50), Math.abs(nextMultiple - 50)) / 5 * 10;
    return score;
  }

  function bchEncodeFormat(data5) {
    let value = data5 << 10;
    const genDeg = 10;
    let g = FORMAT_GENERATOR;
    let d = value;
    // 除算：d の最上位ビット位置に合わせて g をシフトしてXOR
    for (let i = 14; i >= genDeg; i--) {
      if ((d >> i) & 1) {
        d ^= g << (i - genDeg);
      }
    }
    return (value | d) ^ FORMAT_MASK;
  }

  function writeFormatInfo(m, reserved, size, ecLevel, maskPattern) {
    const data5 = (EC_LEVEL_BITS[ecLevel] << 3) | maskPattern;
    const bits15 = bchEncodeFormat(data5); // 15bit
    function bit(i) { return (bits15 >> i) & 1; } // i=0が最下位(末尾)、i=14が最上位(先頭)

    // コピーA（左上まわり）: 列8を上から下（行0-5,7,8）→ 行8を左から右（列7,5-0）で bit0→bit14
    const copyA = [
      [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
      [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
    ];
    for (let i = 0; i < copyA.length; i++) {
      const [r, c] = copyA[i];
      m[r][c] = bit(i);
    }

    // コピーB（右上＋左下、冗長用）: 行8を右から左（列size-1..size-8）→ 列8を下から上（行size-7..size-1）で bit0→bit14
    const copyB = [];
    for (let i = 0; i < 8; i++) copyB.push([8, size - 1 - i]);
    for (let i = 0; i < 7; i++) copyB.push([size - 7 + i, 8]);
    for (let i = 0; i < copyB.length; i++) {
      const [r, c] = copyB[i];
      m[r][c] = bit(i);
    }
  }

  function generateMatrix(text, ecLevel) {
    ecLevel = ecLevel || "M";
    const bytes = utf8Bytes(text);
    const version = chooseVersion(bytes.length, ecLevel);
    if (!version) {
      throw new Error("QRコードに変換するには文字列が長すぎます");
    }
    const size = version * 4 + 17;
    const { m, reserved } = makeMatrix(size);

    placeFinder(m, reserved, 0, 0);
    placeFinder(m, reserved, 0, size - 7);
    placeFinder(m, reserved, size - 7, 0);
    if (ALIGNMENT_CENTER[version]) {
      const center = ALIGNMENT_CENTER[version];
      placeAlignment(m, reserved, center, center);
    }
    placeTiming(m, reserved, size);
    reserveFormatAreas(m, reserved, size);
    placeDarkModule(m, reserved, version);

    const dataCodewords = buildCodewords(text, version, ecLevel);
    const finalCodewords = interleaveWithEC(dataCodewords, version, ecLevel);

    let bestPattern = 0, bestScore = Infinity, bestMatrix = null;
    for (let pattern = 0; pattern < 8; pattern++) {
      const mCopy = m.map((row) => row.slice());
      placeData(mCopy, reserved, size, finalCodewords, pattern);
      const score = penaltyScore(mCopy, size);
      if (score < bestScore) {
        bestScore = score;
        bestPattern = pattern;
        bestMatrix = mCopy;
      }
    }
    writeFormatInfo(bestMatrix, reserved, size, ecLevel, bestPattern);

    const modules = bestMatrix.map((row) => row.map((v) => v === 1));
    return { size, modules };
  }

  function renderToCanvas(canvas, text, opts) {
    opts = opts || {};
    const ecLevel = opts.ecLevel || "M";
    const scale = opts.scale || 6;
    const border = opts.border != null ? opts.border : 4;
    const fg = opts.fg || "#201d1a";
    const bg = opts.bg || "#ffffff";
    const { size, modules } = generateMatrix(text, ecLevel);
    const px = (size + border * 2) * scale;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = fg;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (modules[r][c]) {
          ctx.fillRect((c + border) * scale, (r + border) * scale, scale, scale);
        }
      }
    }
    return { size, modules };
  }

  const QRCode = { generateMatrix, renderToCanvas };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = QRCode;
  } else {
    global.QRCode = QRCode;
  }
})(typeof window !== "undefined" ? window : globalThis);
